/**
 * Generative ambience (DESIGN §5b): a drone, a wind bed, a slow chord pad, a wandering melody, an
 * optional bass pulse and percussion — all derived from the world's `audio.synth` knobs and bent by
 * the current mood. A mood change builds a new layer and crossfades to it.
 *
 * Scheduling is the classic look-ahead pattern: a coarse timer calls `tick()` (≈ every 100 ms) and
 * notes are placed on the audio clock a little ahead, so timing stays tight while JS work stays
 * tiny. Nothing runs between ticks.
 */
import {
  arrange,
  degreeToMidi,
  hashString,
  makeRandom,
  MelodyWalker,
  midiToHz,
  PERCUSSION_PATTERNS,
  PROGRESSIONS,
  type Arrangement,
  type MusicMood,
  type SynthSpec,
  type Timbre,
} from './theory';
import { noiseBuffer, playNoise, playThump, playTone, VoiceBudget } from './voices';

/** seconds the scheduler looks ahead */
export const LOOKAHEAD = 0.35;
/** default crossfade length, seconds */
export const CROSSFADE = 2.5;
/** steps per bar (eighth notes) */
const BAR = 8;

const SUSTAINED: ReadonlySet<Timbre> = new Set(['pad', 'string', 'organ', 'brass']);

interface Layer {
  arr: Arrangement;
  out: GainNode;
  /** continuously running sources (drone, wind, lfo) stopped when the layer fades out */
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  walker: MelodyWalker;
  step: number;
  nextTime: number;
  /** notes held by the melody (steps left) */
  hold: number;
}

export interface AmbienceOptions {
  /** max simultaneous scheduled music voices (default 12) */
  maxVoices?: number;
  /** random source for the melody (default: seeded from `seedText`) */
  random?: () => number;
  /** text the default random source is seeded from (the world title) */
  seedText?: string;
}

export class Ambience {
  readonly budget: VoiceBudget;
  private layer: Layer | null = null;
  private fading: { layer: Layer; until: number }[] = [];
  private readonly random: () => number;
  private _mood: MusicMood = 'explore';

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private synth: Partial<SynthSpec> | undefined,
    opts: AmbienceOptions = {},
  ) {
    this.budget = new VoiceBudget(opts.maxVoices ?? 12);
    this.random = opts.random ?? makeRandom(hashString(opts.seedText ?? 'anyworld'));
  }

  get mood(): MusicMood {
    return this._mood;
  }

  /** the arrangement now playing (null before start) */
  get arrangement(): Arrangement | null {
    return this.layer?.arr ?? null;
  }

  get playing(): boolean {
    return this.layer !== null;
  }

  /** start (or restart) playing the given mood, fading in */
  start(mood: MusicMood = this._mood, fade = CROSSFADE): void {
    this._mood = mood;
    if (this.layer) this.retire(this.layer, fade);
    this.layer = this.buildLayer(arrange(this.synth, mood), fade);
  }

  /** crossfade to another mood; no-op if it is already playing */
  setMood(mood: MusicMood, fade = CROSSFADE): void {
    if (mood === this._mood && this.layer) return;
    this._mood = mood;
    if (this.layer) this.start(mood, fade);
  }

  /** swap the world's synth knobs (new world) — crossfades if playing */
  setSynth(synth: Partial<SynthSpec> | undefined, fade = CROSSFADE): void {
    this.synth = synth;
    if (this.layer) this.start(this._mood, fade);
  }

  /** fade everything out and stop */
  stop(fade = 0.6): void {
    if (this.layer) this.retire(this.layer, fade);
    this.layer = null;
  }

  /**
   * Call after the audio clock stood still or jumped (tab hidden, context suspended): the next
   * notes start from now instead of trying to catch up.
   */
  resync(): void {
    if (this.layer) this.layer.nextTime = this.ctx.currentTime + 0.05;
  }

  /** schedule everything due within the look-ahead window; cheap when nothing is due */
  tick(): void {
    const now = this.ctx.currentTime;
    this.fading = this.fading.filter((f) => {
      if (now < f.until) return true;
      this.destroy(f.layer);
      return false;
    });
    const L = this.layer;
    if (!L) return;
    if (L.nextTime < now - 0.25) L.nextTime = now + 0.05; // stalled: skip, never burst
    let guard = 0;
    while (L.nextTime < now + LOOKAHEAD && guard++ < 64) {
      this.scheduleStep(L, L.step, L.nextTime);
      L.step++;
      L.nextTime += L.arr.stepSeconds;
    }
  }

  dispose(): void {
    if (this.layer) this.destroy(this.layer);
    for (const f of this.fading) this.destroy(f.layer);
    this.layer = null;
    this.fading = [];
  }

  // -------------------------------------------------------------------------

  private buildLayer(arr: Arrangement, fade: number): Layer {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(1, now + Math.max(0.05, fade));
    out.connect(this.dest);
    const layer: Layer = {
      arr,
      out,
      sources: [],
      nodes: [out],
      walker: new MelodyWalker(this.random),
      step: 0,
      nextTime: now + 0.05,
      hold: 0,
    };

    // slow LFO shared by the drone filter and the wind filter
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.05 + this.random() * 0.06;
    layer.sources.push(lfo);
    layer.nodes.push(lfo);

    if (arr.drone > 0) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = arr.cutoff * 0.5;
      filter.Q.value = 0.8;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = arr.cutoff * 0.18;
      lfo.connect(lfoDepth);
      lfoDepth.connect(filter.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.05 * arr.drone;
      filter.connect(g);
      g.connect(out);
      layer.nodes.push(filter, lfoDepth, g);
      const wave: OscillatorType =
        arr.timbre === 'bell' || arr.timbre === 'pluck' ? 'sine' : arr.timbre === 'chip' || arr.timbre === 'organ' ? 'triangle' : 'sawtooth';
      const voices: [number, number][] = [
        [arr.root, 0],
        [arr.root + 7, arr.detune],
      ];
      if (arr.mood === 'eerie' || arr.mood === 'tense') voices.push([arr.root + 1 + 12, -arr.detune]);
      for (const [midi, detune] of voices) {
        const o = ctx.createOscillator();
        o.type = wave;
        o.frequency.value = midiToHz(midi);
        o.detune.value = detune;
        o.connect(filter);
        layer.sources.push(o);
        layer.nodes.push(o);
      }
    }

    if (arr.wind > 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 350 + 900 * arr.brightness;
      bp.Q.value = 1.2;
      const depth = ctx.createGain();
      depth.gain.value = 200;
      lfo.connect(depth);
      depth.connect(bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.045 * arr.wind;
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      layer.sources.push(src);
      layer.nodes.push(src, bp, depth, g);
    }

    for (const s of layer.sources) s.start(now);
    return layer;
  }

  private retire(layer: Layer, fade: number): void {
    const now = this.ctx.currentTime;
    const g = layer.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(0.0001, now + Math.max(0.05, fade));
    const until = now + Math.max(0.05, fade) + 0.1;
    for (const s of layer.sources) {
      try {
        s.stop(until);
      } catch {
        /* already stopped */
      }
    }
    this.fading.push({ layer, until });
  }

  private destroy(layer: Layer): void {
    for (const s of layer.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of layer.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    layer.sources = [];
  }

  private scheduleStep(L: Layer, step: number, t: number): void {
    const a = L.arr;
    const ctx = this.ctx;
    const pos = step % BAR;

    // chord pad: every two bars, the next chord of the mood's progression
    if (step % (BAR * 2) === 0) {
      const prog = PROGRESSIONS[a.mood];
      const chordRoot = prog[Math.floor(step / (BAR * 2)) % prog.length];
      const timbre: Timbre = SUSTAINED.has(a.timbre) ? a.timbre : 'pad';
      for (const d of [0, 2, 4]) {
        playTone(ctx, L.out, this.budget, {
          freq: midiToHz(degreeToMidi(a.root + 12, a.scale, chordRoot + d)),
          at: t,
          dur: a.stepSeconds * BAR * 2 * 0.85,
          level: 0.022,
          timbre,
          cutoff: a.cutoff * 0.7,
        });
      }
    }

    // melody
    if (L.hold > 0) L.hold--;
    else {
      const n = L.walker.next(a.density, a.scale.length);
      if (n) {
        L.hold = n.len - 1;
        playTone(ctx, L.out, this.budget, {
          freq: midiToHz(degreeToMidi(a.root + 12 * a.melodyOctave, a.scale, n.degree)),
          at: t,
          dur: a.stepSeconds * n.len * 0.9,
          level: 0.06 * a.melody,
          timbre: a.timbre,
          cutoff: a.cutoff,
        });
      }
    }

    // bass pulse on the beats
    if (a.pulse > 0 && pos % 2 === 0) {
      playTone(ctx, L.out, this.budget, {
        freq: midiToHz(a.root + (pos === 4 && a.mood === 'boss' ? 7 : 0)),
        at: t,
        dur: a.stepSeconds * 0.7,
        level: 0.07 * a.pulse,
        timbre: 'pluck',
        cutoff: Math.min(900, a.cutoff),
      });
    }

    // percussion
    if (a.percussion !== 'none') {
      const kit = PERCUSSION_PATTERNS[a.percussion];
      const base = 0.12 * a.percussionLevel;
      for (const [inst, pattern] of Object.entries(kit)) {
        const c = pattern[pos];
        if (c !== 'x' && c !== 'o') continue;
        this.hit(L, inst, t, base * (c === 'x' ? 1 : 0.55), c === 'x');
      }
    }
  }

  private hit(L: Layer, inst: string, t: number, level: number, accent: boolean): void {
    const ctx = this.ctx;
    const b = this.budget;
    switch (inst) {
      case 'kick':
        playThump(ctx, L.out, b, t, 120, 45, 0.25, level * 1.4);
        break;
      case 'low':
        playThump(ctx, L.out, b, t, 150, 75, 0.3, level * 1.3);
        break;
      case 'high':
        playThump(ctx, L.out, b, t, 280, 170, 0.18, level);
        break;
      case 'thump':
        playThump(ctx, L.out, b, t, accent ? 75 : 65, 38, 0.2, level * 1.5);
        break;
      case 'hat':
        playNoise(ctx, L.out, b, { at: t, dur: 0.04, level: level * 0.6, filter: 'highpass', freq: 7000 });
        break;
      case 'brush':
        playNoise(ctx, L.out, b, { at: t, dur: 0.12, level: level * 0.5, filter: 'bandpass', freq: 3200, sweepTo: 2000, q: 0.8 });
        break;
      case 'tick':
        playNoise(ctx, L.out, b, { at: t, dur: 0.025, level: level * 0.7, filter: 'bandpass', freq: accent ? 3800 : 2600, q: 8 });
        break;
    }
  }
}
