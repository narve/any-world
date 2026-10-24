/**
 * Procedural sound effects (DESIGN §5b): which GameEvents make a sound (pure, tested), and how each
 * sound is synthesised with the world's own timbre and key so a chiptune world blips and a bell
 * world chimes.
 */
import type { GameEvent } from '../../engine/types';
import { degreeToMidi, midiToHz, normalizeSynth, rootMidi, SCALES, type SynthSpec, type Timbre } from './theory';
import { playNoise, playThump, playTone, type VoiceBudget } from './voices';

export const SFX_NAMES = ['death', 'win', 'levelup', 'hurt', 'hit', 'kill', 'miss', 'pickup', 'use', 'heal', 'step'] as const;
export type SfxName = (typeof SFX_NAMES)[number];

/** most important first; at most MAX_SFX_PER_BATCH play for one batch of events */
const PRIORITY: Record<SfxName, number> = Object.fromEntries(SFX_NAMES.map((n, i) => [n, i])) as Record<SfxName, number>;
export const MAX_SFX_PER_BATCH = 3;

/**
 * The sounds for one batch of engine events (one player action and the turns it caused), most
 * important first, without duplicates. `playerId` is the player's actor id; without it, steps are
 * not played and every hit counts as the player's.
 */
export function sfxForEvents(events: readonly GameEvent[], playerId?: string): SfxName[] {
  const set = new Set<SfxName>();
  for (const e of events) {
    switch (e.type) {
      case 'moved':
        if (playerId && e.actorId === playerId) set.add('step');
        break;
      case 'attacked': {
        const mine = !playerId || e.attackerId === playerId;
        const atMe = !!playerId && e.targetId === playerId;
        if (!mine && !atMe) break; // monsters fighting each other off-screen stay quiet
        if (!e.hit) set.add('miss');
        else set.add(atMe ? 'hurt' : 'hit');
        break;
      }
      case 'died':
        set.add(playerId && e.actorId === playerId ? 'death' : 'kill');
        break;
      case 'item_picked':
        set.add('pickup');
        break;
      case 'item_used':
      case 'equipped':
        set.add('use');
        break;
      case 'healed':
        if (!playerId || e.actorId === playerId) set.add('heal');
        break;
      case 'level_up':
        set.add('levelup');
        break;
      case 'game_over':
        set.add(e.result === 'won' ? 'win' : 'death');
        break;
    }
  }
  return [...set].sort((a, b) => PRIORITY[a] - PRIORITY[b]).slice(0, MAX_SFX_PER_BATCH);
}

/** per-world sound palette, derived from audio.synth */
export interface SfxPalette {
  timbre: Timbre;
  /** a playable, short timbre for melodic blips (pads are too slow for sfx) */
  blip: Timbre;
  /** MIDI root, octave 4 */
  root: number;
  scale: readonly number[];
  /** lowpass cutoff for tonal sfx */
  cutoff: number;
  /** extra noise in impacts (noise/percussive worlds) */
  grit: number;
}

export function sfxPalette(synth: Partial<SynthSpec> | undefined): SfxPalette {
  const s = normalizeSynth(synth);
  const blip: Timbre = s.timbre === 'pad' || s.timbre === 'string' ? 'pluck' : s.timbre === 'noise' ? 'pluck' : s.timbre;
  return {
    timbre: s.timbre,
    blip,
    root: rootMidi(s.key, 4),
    scale: SCALES[s.scale],
    cutoff: 800 * Math.pow(8, s.brightness),
    grit: s.timbre === 'noise' || s.percussion === 'electronic' || s.percussion === 'tribal' ? 1.4 : 1,
  };
}

/**
 * Play one effect at `at` (context seconds). `variant` alternates small details (left/right
 * footstep). Returns how many voices were started.
 */
export function playSfx(ctx: BaseAudioContext, dest: AudioNode, budget: VoiceBudget, name: SfxName, p: SfxPalette, at: number, variant = 0): number {
  const note = (deg: number, oct = 0) => midiToHz(degreeToMidi(p.root + 12 * oct, p.scale, deg));
  let n = 0;
  const tone = (freq: number, t: number, dur: number, level: number, timbre: Timbre = p.blip, glideTo?: number) => {
    if (playTone(ctx, dest, budget, { freq, at: t, dur, level, timbre, cutoff: p.cutoff, glideTo })) n++;
  };
  const noise = (t: number, dur: number, level: number, filter: BiquadFilterType, freq: number, sweepTo?: number, q?: number) => {
    if (playNoise(ctx, dest, budget, { at: t, dur, level, filter, freq, sweepTo, q })) n++;
  };
  const thump = (t: number, from: number, to: number, dur: number, level: number) => {
    if (playThump(ctx, dest, budget, t, from, to, dur, level)) n++;
  };

  switch (name) {
    case 'step':
      noise(at, 0.05, 0.05, 'bandpass', variant % 2 ? 900 : 700, 400, 1.5);
      break;
    case 'hit':
      thump(at, 180, 60, 0.12, 0.35);
      noise(at, 0.09, 0.22 * p.grit, 'lowpass', 2600, 500);
      break;
    case 'hurt':
      thump(at, 120, 45, 0.18, 0.4);
      tone(note(0, -1), at, 0.18, 0.12, 'brass', note(-2, -1));
      noise(at, 0.12, 0.15 * p.grit, 'lowpass', 1800, 300);
      break;
    case 'miss':
      noise(at, 0.18, 0.14, 'bandpass', 3000, 600, 2);
      break;
    case 'kill':
      tone(note(4), at, 0.08, 0.1);
      tone(note(0), at + 0.08, 0.14, 0.1);
      break;
    case 'pickup':
      tone(note(2, 1), at, 0.06, 0.1);
      tone(note(4, 1), at + 0.07, 0.1, 0.1);
      break;
    case 'use':
      tone(note(0), at, 0.25, 0.09, p.blip, note(4, 1));
      noise(at, 0.2, 0.05, 'bandpass', 1500, 5000, 3);
      break;
    case 'heal':
      tone(note(4, 1), at, 0.3, 0.06, 'bell');
      tone(note(7, 1), at + 0.1, 0.3, 0.05, 'bell');
      break;
    case 'levelup': {
      const degs = [0, 2, 4, 7];
      degs.forEach((d, i) => tone(note(d), at + i * 0.09, i === degs.length - 1 ? 0.5 : 0.1, 0.11));
      break;
    }
    case 'win': {
      const degs = [0, 2, 4, 7, 9];
      degs.forEach((d, i) => tone(note(d), at + i * 0.12, i === degs.length - 1 ? 1.2 : 0.14, 0.12));
      tone(note(0, -1), at + 0.48, 1.4, 0.08, 'pad');
      break;
    }
    case 'death':
      tone(note(0), at, 1.3, 0.14, p.timbre === 'chip' ? 'chip' : 'brass', note(-7, -1));
      thump(at, 90, 30, 0.6, 0.35);
      noise(at, 1.2, 0.08, 'lowpass', 1200, 120);
      break;
  }
  return n;
}
