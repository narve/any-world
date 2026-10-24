/**
 * Pure music theory and mood tables for the generative ambience (DESIGN §5b). No WebAudio here:
 * everything is plain data and functions so it can be unit tested and reasoned about.
 */
import type { AudioSpec } from '../../schema/world';

export type SynthSpec = AudioSpec['synth'];
export type KeyName = SynthSpec['key'];
export type ScaleName = SynthSpec['scale'];
export type Timbre = SynthSpec['timbre'];
export type Percussion = SynthSpec['percussion'];

/** the GM / area music moods (schema: GmAction 'mood'.music and AreaPlan.music) */
export const MOODS = ['explore', 'tense', 'calm', 'eerie', 'boss', 'upbeat'] as const;
export type MusicMood = (typeof MOODS)[number];

export function isMood(x: unknown): x is MusicMood {
  return typeof x === 'string' && (MOODS as readonly string[]).includes(x);
}

const KEYS: readonly KeyName[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** semitone offsets from the root, one octave */
export const SCALES: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
  whole_tone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** MIDI note number → Hz (A4 = 69 = 440 Hz) */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI number of the key's root in the given octave (C4 = 60) */
export function rootMidi(key: KeyName, octave = 3): number {
  const i = KEYS.indexOf(key);
  return 12 * (octave + 1) + (i < 0 ? 9 : i);
}

/**
 * MIDI note of a scale degree (0 = root; may be negative or exceed the scale length — it wraps
 * into neighbouring octaves).
 */
export function degreeToMidi(root: number, scale: readonly number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return root + oct * 12 + scale[idx];
}

/** how each mood bends the world's own synth spec */
export interface MoodProfile {
  /** multiplies the world tempo */
  tempo: number;
  /** 0..1 chance that a melody step sounds */
  density: number;
  /** melody octave shift */
  octave: number;
  /** added to the world's brightness (clamped 0..1) */
  brightness: number;
  /** drone level multiplier (0 = no drone even if the world asks for one) */
  drone: number;
  /** low pulse on every beat (an ostinato on the root) */
  pulse: number;
  /** percussion to use when the world has none (null = stay silent) */
  fallbackPercussion: Percussion | null;
  /** percussion level multiplier */
  percussion: number;
  /** detune of the second drone voice, cents (eerie beating) */
  detune: number;
  /** replaces a scale that does not fit the mood (null = keep the world's) */
  scale: (s: ScaleName) => ScaleName;
  /** filtered-noise wind bed level */
  wind: number;
  /** melody level */
  melody: number;
}

const keep = (s: ScaleName): ScaleName => s;
const darker = (s: ScaleName): ScaleName =>
  s === 'major' || s === 'lydian' || s === 'mixolydian' ? 'dorian' : s === 'pentatonic' ? 'blues' : s;
const brighter = (s: ScaleName): ScaleName =>
  s === 'minor' || s === 'phrygian' ? 'dorian' : s === 'blues' || s === 'chromatic' ? 'pentatonic' : s;
const stranger = (s: ScaleName): ScaleName =>
  s === 'major' || s === 'pentatonic' || s === 'mixolydian' ? 'lydian' : s === 'minor' || s === 'dorian' ? 'phrygian' : s;

export const MOOD_PROFILES: Record<MusicMood, MoodProfile> = {
  explore: { tempo: 1, density: 0.32, octave: 0, brightness: 0, drone: 1, pulse: 0, fallbackPercussion: null, percussion: 0.7, detune: 6, scale: keep, wind: 0.15, melody: 1 },
  calm: { tempo: 0.75, density: 0.18, octave: 0, brightness: -0.15, drone: 0.9, pulse: 0, fallbackPercussion: null, percussion: 0.35, detune: 4, scale: brighter, wind: 0.1, melody: 0.8 },
  tense: { tempo: 1.2, density: 0.42, octave: 0, brightness: 0.1, drone: 1.1, pulse: 0.7, fallbackPercussion: 'heartbeat', percussion: 1, detune: 14, scale: darker, wind: 0.25, melody: 0.85 },
  eerie: { tempo: 0.6, density: 0.14, octave: 1, brightness: -0.2, drone: 1.2, pulse: 0, fallbackPercussion: null, percussion: 0.4, detune: 22, scale: stranger, wind: 0.45, melody: 0.7 },
  boss: { tempo: 1.35, density: 0.55, octave: -1, brightness: 0.2, drone: 1.2, pulse: 1, fallbackPercussion: 'tribal', percussion: 1.2, detune: 10, scale: darker, wind: 0.2, melody: 1 },
  upbeat: { tempo: 1.15, density: 0.5, octave: 1, brightness: 0.15, drone: 0.6, pulse: 0.4, fallbackPercussion: 'soft', percussion: 1, detune: 5, scale: brighter, wind: 0, melody: 1 },
};

/** the concrete arrangement for a world + mood */
export interface Arrangement {
  mood: MusicMood;
  timbre: Timbre;
  /** MIDI of the bass/drone root */
  root: number;
  scale: readonly number[];
  scaleName: ScaleName;
  /** seconds per step (eighth notes) */
  stepSeconds: number;
  density: number;
  /** melody register: degrees are added to root + 12 * melodyOctave */
  melodyOctave: number;
  /** lowpass cutoff for pads/drones, Hz */
  cutoff: number;
  brightness: number;
  drone: number;
  pulse: number;
  percussion: Percussion;
  percussionLevel: number;
  detune: number;
  wind: number;
  melody: number;
}

export const DEFAULT_SYNTH: SynthSpec = {
  key: 'A',
  scale: 'minor',
  tempo: 80,
  timbre: 'pad',
  drone: true,
  percussion: 'none',
  brightness: 0.4,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** fills defaults for a partially specified synth block (worlds from older prompts) */
export function normalizeSynth(s: Partial<SynthSpec> | undefined | null): SynthSpec {
  const v = { ...DEFAULT_SYNTH, ...(s ?? {}) } as SynthSpec;
  if (!KEYS.includes(v.key)) v.key = DEFAULT_SYNTH.key;
  if (!(v.scale in SCALES)) v.scale = DEFAULT_SYNTH.scale;
  v.tempo = clamp(Number.isFinite(v.tempo) ? v.tempo : DEFAULT_SYNTH.tempo, 40, 180);
  v.brightness = clamp(Number.isFinite(v.brightness) ? v.brightness : DEFAULT_SYNTH.brightness, 0, 1);
  return v;
}

export function arrange(synth: Partial<SynthSpec> | undefined, mood: MusicMood): Arrangement {
  const s = normalizeSynth(synth);
  const p = MOOD_PROFILES[mood];
  const scaleName = p.scale(s.scale);
  const bpm = clamp(s.tempo * p.tempo, 36, 200);
  const brightness = clamp(s.brightness + p.brightness, 0, 1);
  const percussion: Percussion = s.percussion !== 'none' ? s.percussion : (p.fallbackPercussion ?? 'none');
  return {
    mood,
    timbre: s.timbre,
    root: rootMidi(s.key, 2),
    scale: SCALES[scaleName],
    scaleName,
    stepSeconds: 60 / bpm / 2,
    density: p.density,
    melodyOctave: 2 + p.octave,
    // 300 Hz (dark) .. ~4.8 kHz (bright), exponential
    cutoff: 300 * Math.pow(16, brightness),
    brightness,
    drone: s.drone ? p.drone : p.drone * 0.35,
    pulse: p.pulse,
    percussion,
    percussionLevel: s.percussion !== 'none' ? p.percussion : p.percussion * 0.6,
    detune: p.detune,
    wind: s.timbre === 'noise' ? Math.max(p.wind, 0.3) : p.wind,
    melody: p.melody,
  };
}

/** 8-step patterns (one bar of eighth notes): 'x' loud, 'o' soft, '.' rest */
export const PERCUSSION_PATTERNS: Record<Exclude<Percussion, 'none'>, Record<string, string>> = {
  soft: { brush: '..o...o.', kick: 'o.......' },
  tribal: { low: 'x..x..x.', high: '.....o.o' },
  electronic: { kick: 'x...x...', hat: '.o.o.o.o' },
  clockwork: { tick: 'xoxoxoxo' },
  heartbeat: { thump: 'xo......' },
};

/** small seeded PRNG (mulberry32) so a world's music is recognisably its own */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A wandering melody: a random walk over scale degrees that prefers small steps and drifts back
 * towards the tonic, with occasional rests and held notes. Pure given its random source.
 */
export class MelodyWalker {
  private degree = 0;
  constructor(private readonly random: () => number) {}

  /** next note for a step, or null for a rest. `len` is in steps. */
  next(density: number, scaleLen: number): { degree: number; len: number } | null {
    if (this.random() >= density) return null;
    const r = this.random();
    const step = r < 0.35 ? 1 : r < 0.7 ? -1 : r < 0.82 ? 2 : r < 0.94 ? -2 : r < 0.97 ? 4 : -3;
    let d = this.degree + step;
    // gravity towards the tonic region: stay within about an octave and a half
    const lo = -Math.ceil(scaleLen / 2);
    const hi = scaleLen + Math.floor(scaleLen / 2);
    if (d < lo || d > hi) d = this.degree - step;
    if (this.random() < 0.12) d = Math.round(d / scaleLen) * scaleLen; // land on a root now and then
    this.degree = d;
    const lr = this.random();
    const len = lr < 0.5 ? 1 : lr < 0.8 ? 2 : lr < 0.95 ? 3 : 4;
    return { degree: d, len };
  }
}

/** chord progressions in scale degrees (triad roots), cycled every two bars */
export const PROGRESSIONS: Record<MusicMood, readonly number[]> = {
  explore: [0, 5, 3, 4],
  calm: [0, 3, 0, 4],
  tense: [0, 1, 0, 6],
  eerie: [0, 1, 0, 1],
  boss: [0, 6, 5, 6],
  upbeat: [0, 4, 5, 3],
};
