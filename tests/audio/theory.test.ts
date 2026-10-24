import { describe, expect, it } from 'vitest';
import {
  arrange,
  degreeToMidi,
  isMood,
  makeRandom,
  MelodyWalker,
  midiToHz,
  MOOD_PROFILES,
  MOODS,
  normalizeSynth,
  rootMidi,
  SCALES,
} from '../../src/client/audio/theory';

describe('audio theory', () => {
  it('pitches: A4 = 440 Hz, C4 = MIDI 60', () => {
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(midiToHz(81)).toBeCloseTo(880);
    expect(rootMidi('C', 4)).toBe(60);
    expect(rootMidi('A', 4)).toBe(69);
    expect(rootMidi('F#', 2)).toBe(42);
  });

  it('scale degrees wrap into neighbouring octaves', () => {
    const minor = SCALES.minor;
    expect(degreeToMidi(57, minor, 0)).toBe(57);
    expect(degreeToMidi(57, minor, 2)).toBe(60);
    expect(degreeToMidi(57, minor, 7)).toBe(69);
    expect(degreeToMidi(57, minor, -1)).toBe(55);
    expect(degreeToMidi(57, SCALES.pentatonic, 5)).toBe(69);
  });

  it('every mood has a profile and mood names are validated', () => {
    for (const m of MOODS) expect(MOOD_PROFILES[m]).toBeDefined();
    expect(isMood('boss')).toBe(true);
    expect(isMood('disco')).toBe(false);
    expect(isMood(undefined)).toBe(false);
  });

  it('normalizes partial or broken synth specs', () => {
    const s = normalizeSynth({ tempo: 999, brightness: -3, key: 'H' as never });
    expect(s.tempo).toBe(180);
    expect(s.brightness).toBe(0);
    expect(s.key).toBe('A');
    expect(normalizeSynth(undefined).scale).toBe('minor');
  });

  it('moods bend the world: boss is faster and busier than calm, eerie is darker', () => {
    const synth = { key: 'D' as const, scale: 'minor' as const, tempo: 90, timbre: 'pad' as const, drone: true, percussion: 'none' as const, brightness: 0.5 };
    const calm = arrange(synth, 'calm');
    const boss = arrange(synth, 'boss');
    const eerie = arrange(synth, 'eerie');
    expect(boss.stepSeconds).toBeLessThan(calm.stepSeconds);
    expect(boss.density).toBeGreaterThan(calm.density);
    expect(eerie.cutoff).toBeLessThan(arrange(synth, 'explore').cutoff);
    // no world percussion: boss falls back to tribal drums, calm stays silent
    expect(boss.percussion).toBe('tribal');
    expect(calm.percussion).toBe('none');
    // world percussion is kept in every mood
    expect(arrange({ ...synth, percussion: 'clockwork' }, 'calm').percussion).toBe('clockwork');
    // tense darkens a major world, upbeat brightens a minor one
    expect(arrange({ ...synth, scale: 'major' }, 'tense').scaleName).toBe('dorian');
    expect(arrange(synth, 'upbeat').scaleName).toBe('dorian');
  });

  it('the melody walker is deterministic for a seed and stays in range', () => {
    const a = new MelodyWalker(makeRandom(42));
    const b = new MelodyWalker(makeRandom(42));
    const seqA: unknown[] = [];
    const seqB: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      seqA.push(a.next(0.6, 7));
      seqB.push(b.next(0.6, 7));
    }
    expect(seqA).toEqual(seqB);
    const notes = seqA.filter(Boolean) as { degree: number; len: number }[];
    expect(notes.length).toBeGreaterThan(60);
    expect(notes.length).toBeLessThan(180);
    for (const n of notes) {
      expect(n.degree).toBeGreaterThanOrEqual(-7);
      expect(n.degree).toBeLessThanOrEqual(10);
      expect(n.len).toBeGreaterThanOrEqual(1);
      expect(n.len).toBeLessThanOrEqual(4);
    }
    const rests = new MelodyWalker(makeRandom(1));
    for (let i = 0; i < 50; i++) expect(rests.next(0, 7)).toBeNull();
  });
});
