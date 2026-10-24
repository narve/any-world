/**
 * WebAudio synthesis primitives shared by the ambience and the sound effects. Every voice is a
 * handful of native nodes that stop and disconnect themselves; a `VoiceBudget` caps how many play
 * at once so phones stay cool (DESIGN §6b).
 */
import type { Timbre } from './theory';

/** counts live voices; callers skip optional notes when the budget is spent */
export class VoiceBudget {
  active = 0;
  constructor(public readonly max: number) {}
  get full(): boolean {
    return this.active >= this.max;
  }
  /** register a voice; `release` is called when its source ends */
  track(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.active++;
    src.onended = () => {
      this.active = Math.max(0, this.active - 1);
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
  }
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** one shared second of white noise per context (generated once; looped/offset as needed) */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBuffers.get(ctx);
  if (b) return b;
  const len = Math.max(1, Math.floor(ctx.sampleRate));
  b = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = b.getChannelData(0);
  let seed = 0x2545f491;
  for (let i = 0; i < len; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
  }
  noiseBuffers.set(ctx, b);
  return b;
}

/** envelope shape for a timbre */
export interface TimbreShape {
  wave: OscillatorType;
  attack: number;
  /** decay to sustain, seconds */
  decay: number;
  sustain: number;
  release: number;
  /** second oscillator: frequency ratio and level (0 = none) */
  partialRatio: number;
  partialLevel: number;
  /** filter cutoff multiplier (relative to the arrangement's cutoff) */
  filter: number;
  /** filtered noise instead of an oscillator */
  noise: boolean;
}

export const TIMBRES: Record<Timbre, TimbreShape> = {
  pad: { wave: 'sawtooth', attack: 0.5, decay: 0.6, sustain: 0.7, release: 1.4, partialRatio: 1.005, partialLevel: 0.6, filter: 0.6, noise: false },
  pluck: { wave: 'triangle', attack: 0.005, decay: 0.35, sustain: 0.05, release: 0.25, partialRatio: 2, partialLevel: 0.2, filter: 1.4, noise: false },
  bell: { wave: 'sine', attack: 0.004, decay: 1.2, sustain: 0.1, release: 1.2, partialRatio: 2.76, partialLevel: 0.35, filter: 3, noise: false },
  organ: { wave: 'square', attack: 0.03, decay: 0.1, sustain: 0.8, release: 0.15, partialRatio: 2, partialLevel: 0.4, filter: 0.8, noise: false },
  string: { wave: 'sawtooth', attack: 0.35, decay: 0.4, sustain: 0.75, release: 0.8, partialRatio: 0.997, partialLevel: 0.7, filter: 0.7, noise: false },
  chip: { wave: 'square', attack: 0.002, decay: 0.12, sustain: 0.4, release: 0.05, partialRatio: 0, partialLevel: 0, filter: 4, noise: false },
  noise: { wave: 'sine', attack: 0.2, decay: 0.5, sustain: 0.5, release: 0.8, partialRatio: 0, partialLevel: 0, filter: 1, noise: true },
  brass: { wave: 'sawtooth', attack: 0.07, decay: 0.3, sustain: 0.6, release: 0.3, partialRatio: 1.5, partialLevel: 0.15, filter: 1.1, noise: false },
};

export interface ToneOptions {
  freq: number;
  /** start time (context seconds) */
  at: number;
  /** held length before release, seconds */
  dur: number;
  level: number;
  timbre: Timbre;
  /** base lowpass cutoff, Hz */
  cutoff: number;
  /** pitch glide target (Hz) over the note, for sfx */
  glideTo?: number;
  detune?: number;
}

/**
 * Schedule one note. Returns false (and plays nothing) when the budget is full.
 * Graph: osc (+ partial) → lowpass → envelope gain → dest.
 */
export function playTone(ctx: BaseAudioContext, dest: AudioNode, budget: VoiceBudget, o: ToneOptions): boolean {
  if (budget.full || !(o.freq > 0) || !(o.level > 0)) return false;
  const shape = TIMBRES[o.timbre] ?? TIMBRES.pad;
  const t0 = Math.max(o.at, ctx.currentTime);
  const end = t0 + o.dur + shape.release;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(o.level, t0 + shape.attack);
  env.gain.setTargetAtTime(o.level * shape.sustain + 0.0001, t0 + shape.attack, shape.decay / 3 + 0.001);
  env.gain.setTargetAtTime(0.0001, t0 + Math.max(o.dur, shape.attack), shape.release / 4 + 0.001);
  const filter = ctx.createBiquadFilter();
  filter.type = shape.noise ? 'bandpass' : 'lowpass';
  filter.frequency.setValueAtTime(shape.noise ? o.freq : Math.min(18000, o.cutoff * shape.filter), t0);
  filter.Q.value = shape.noise ? 18 : 0.7;
  filter.connect(env);
  env.connect(dest);
  const nodes: AudioNode[] = [filter, env];

  let main: AudioScheduledSourceNode;
  if (shape.noise) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    src.connect(filter);
    main = src;
    nodes.push(src);
  } else {
    const osc = ctx.createOscillator();
    osc.type = shape.wave;
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.glideTo && o.glideTo > 0) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t0 + o.dur);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    osc.connect(filter);
    main = osc;
    nodes.push(osc);
    if (shape.partialLevel > 0 && shape.partialRatio > 0) {
      const p = ctx.createOscillator();
      const pg = ctx.createGain();
      p.type = shape.wave === 'square' ? 'sine' : shape.wave;
      p.frequency.setValueAtTime(o.freq * shape.partialRatio, t0);
      if (o.glideTo && o.glideTo > 0) p.frequency.exponentialRampToValueAtTime(o.glideTo * shape.partialRatio, t0 + o.dur);
      pg.gain.value = shape.partialLevel;
      p.connect(pg);
      pg.connect(filter);
      p.start(t0);
      p.stop(end + 0.05);
      nodes.push(p, pg);
    }
  }
  main.start(t0);
  main.stop(end + 0.05);
  budget.track(main, nodes);
  return true;
}

export interface NoiseHitOptions {
  at: number;
  dur: number;
  level: number;
  filter: BiquadFilterType;
  freq: number;
  /** filter sweep target, Hz */
  sweepTo?: number;
  q?: number;
}

/** a short burst of filtered noise (hats, brushes, whooshes, footsteps) */
export function playNoise(ctx: BaseAudioContext, dest: AudioNode, budget: VoiceBudget, o: NoiseHitOptions): boolean {
  if (budget.full || !(o.level > 0)) return false;
  const t0 = Math.max(o.at, ctx.currentTime);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = o.filter;
  filter.frequency.setValueAtTime(o.freq, t0);
  if (o.sweepTo) filter.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + o.dur);
  filter.Q.value = o.q ?? 1;
  const env = ctx.createGain();
  env.gain.setValueAtTime(o.level, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(filter);
  filter.connect(env);
  env.connect(dest);
  // random offset into the shared buffer so repeated hits do not sound identical
  const offset = ((t0 * 7919) % 1) * 0.5;
  src.start(t0, offset, o.dur + 0.02);
  budget.track(src, [src, filter, env]);
  return true;
}

/** a pitched thump: sine with a fast downward glide (kicks, toms, heartbeats, impacts) */
export function playThump(ctx: BaseAudioContext, dest: AudioNode, budget: VoiceBudget, at: number, from: number, to: number, dur: number, level: number): boolean {
  if (budget.full || !(level > 0)) return false;
  const t0 = Math.max(at, ctx.currentTime);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(level, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env);
  env.connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  budget.track(osc, [osc, env]);
  return true;
}
