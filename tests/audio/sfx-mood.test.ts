import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/engine/types';
import { DANGER_BATCHES, MoodDirector, moodFromGmActions } from '../../src/client/audio/mood';
import { MAX_SFX_PER_BATCH, playSfx, SFX_NAMES, sfxForEvents, sfxPalette } from '../../src/client/audio/sfx';
import { VoiceBudget } from '../../src/client/audio/voices';
import { FakeAudioContext, FakeNode } from './fake-audio';

const P = 'p1';
const pos = { x: 0, y: 0 };

describe('sfxForEvents', () => {
  it('maps player actions to sounds', () => {
    expect(sfxForEvents([{ type: 'moved', actorId: P, from: pos, to: pos }], P)).toEqual(['step']);
    expect(sfxForEvents([{ type: 'moved', actorId: 'rat', from: pos, to: pos }], P)).toEqual([]);
    expect(sfxForEvents([{ type: 'attacked', attackerId: P, targetId: 'rat', hit: true, damage: 3, damageType: 'blunt', ranged: false }], P)).toEqual(['hit']);
    expect(sfxForEvents([{ type: 'attacked', attackerId: P, targetId: 'rat', hit: false, damage: 0, damageType: 'blunt', ranged: false }], P)).toEqual(['miss']);
    expect(sfxForEvents([{ type: 'attacked', attackerId: 'rat', targetId: P, hit: true, damage: 2, damageType: 'bite', ranged: false }], P)).toEqual(['hurt']);
    expect(sfxForEvents([{ type: 'item_picked', itemId: 'i1', defId: 'lamp' }], P)).toEqual(['pickup']);
    expect(sfxForEvents([{ type: 'item_used', defId: 'tonic', consumed: true }], P)).toEqual(['use']);
    expect(sfxForEvents([{ type: 'level_up', level: 2, choices: [] }], P)).toEqual(['levelup']);
    expect(sfxForEvents([{ type: 'died', actorId: 'rat', defId: 'rat' }], P)).toEqual(['kill']);
    expect(sfxForEvents([{ type: 'died', actorId: P, defId: 'hero' }], P)).toEqual(['death']);
    expect(sfxForEvents([{ type: 'game_over', result: 'won', reason: 'x' }], P)).toEqual(['win']);
  });

  it('ignores fights between other actors and unrelated events', () => {
    const ev: GameEvent[] = [
      { type: 'attacked', attackerId: 'a', targetId: 'b', hit: true, damage: 1, damageType: 'x', ranged: false },
      { type: 'message', text: 'hi', kind: 'info' },
      { type: 'noise', pos, radius: 3 },
    ];
    expect(sfxForEvents(ev, P)).toEqual([]);
  });

  it('dedupes, orders by importance and caps a batch', () => {
    const ev: GameEvent[] = [
      { type: 'moved', actorId: P, from: pos, to: pos },
      { type: 'item_picked', itemId: 'i1', defId: 'a' },
      { type: 'item_picked', itemId: 'i2', defId: 'b' },
      { type: 'attacked', attackerId: P, targetId: 'rat', hit: true, damage: 3, damageType: 'x', ranged: false },
      { type: 'died', actorId: 'rat', defId: 'rat' },
      { type: 'level_up', level: 3, choices: [] },
    ];
    const out = sfxForEvents(ev, P);
    expect(out).toEqual(['levelup', 'hit', 'kill']);
    expect(out.length).toBe(MAX_SFX_PER_BATCH);
  });

  it('without a player id: no steps, every hit counts', () => {
    expect(sfxForEvents([{ type: 'moved', actorId: P, from: pos, to: pos }])).toEqual([]);
    expect(sfxForEvents([{ type: 'attacked', attackerId: 'a', targetId: 'b', hit: true, damage: 1, damageType: 'x', ranged: false }])).toEqual(['hit']);
  });
});

describe('playSfx', () => {
  it('every effect makes sound in every timbre and cleans up after itself', () => {
    for (const timbre of ['pad', 'pluck', 'bell', 'organ', 'string', 'chip', 'noise', 'brass'] as const) {
      const ctx = new FakeAudioContext();
      const dest = new FakeNode(ctx, 'bus');
      const budget = new VoiceBudget(64);
      const pal = sfxPalette({ timbre, key: 'E', scale: 'phrygian', brightness: 0.7 });
      for (const name of SFX_NAMES) {
        const n = playSfx(ctx as unknown as AudioContext, dest as unknown as AudioNode, budget, name, pal, ctx.currentTime);
        expect(n, `${timbre}/${name}`).toBeGreaterThan(0);
      }
      expect(budget.active).toBeGreaterThan(0);
      ctx.advance(10);
      expect(budget.active).toBe(0);
      // everything but the bus and the destination is disconnected again
      const leftovers = ctx.nodes.filter((nd) => nd !== dest && nd !== ctx.destination && !nd.disconnected);
      expect(leftovers).toEqual([]);
    }
  });

  it('respects the voice budget', () => {
    const ctx = new FakeAudioContext();
    const dest = new FakeNode(ctx, 'bus');
    const budget = new VoiceBudget(2);
    const pal = sfxPalette(undefined);
    const n = playSfx(ctx as unknown as AudioContext, dest as unknown as AudioNode, budget, 'win', pal, 0);
    expect(n).toBe(2);
    expect(playSfx(ctx as unknown as AudioContext, dest as unknown as AudioNode, budget, 'hit', pal, 0)).toBe(0);
  });

  it('timbre and key change the palette', () => {
    const chip = sfxPalette({ timbre: 'chip', key: 'C' });
    const pad = sfxPalette({ timbre: 'pad', key: 'G' });
    expect(chip.blip).toBe('chip');
    expect(pad.blip).toBe('pluck');
    expect(chip.root).toBe(60);
    expect(pad.root).toBe(67);
  });
});

describe('MoodDirector', () => {
  it('follows area music, GM overrides and resets on a new area', () => {
    const d = new MoodDirector(['calm', 'eerie', 'boss']);
    expect(d.current).toBe('calm');
    d.setGm('upbeat');
    expect(d.current).toBe('upbeat');
    expect(d.onEvents([{ type: 'area_entered', index: 1 }])).toBe('eerie');
    expect(d.onEvents([{ type: 'area_entered', index: 2 }])).toBe('boss');
    expect(d.onEvents([{ type: 'area_entered', index: 9 }])).toBe('explore');
  });

  it('danger makes relaxed areas tense for a while, not boss areas', () => {
    const d = new MoodDirector(['explore', 'boss']);
    expect(d.onEvents([{ type: 'low_hp' }], P)).toBe('tense');
    for (let i = 0; i < DANGER_BATCHES - 1; i++) expect(d.onEvents([{ type: 'moved', actorId: P, from: pos, to: pos }], P)).toBe('tense');
    expect(d.onEvents([{ type: 'moved', actorId: P, from: pos, to: pos }], P)).toBe('explore');
    expect(d.onEvents([{ type: 'attacked', attackerId: 'rat', targetId: P, hit: true, damage: 1, damageType: 'x', ranged: false }], P)).toBe('tense');
    // monsters fighting each other are no danger to the player
    const quiet = new MoodDirector(['calm']);
    expect(quiet.onEvents([{ type: 'attacked', attackerId: 'a', targetId: 'b', hit: true, damage: 1, damageType: 'x', ranged: false }], P)).toBe('calm');
    d.onEvents([{ type: 'area_entered', index: 1 }]);
    expect(d.onEvents([{ type: 'low_hp' }], P)).toBe('boss');
  });

  it('the end of the run wins over everything', () => {
    const d = new MoodDirector(['boss']);
    d.setGm('tense');
    expect(d.onEvents([{ type: 'game_over', result: 'lost', reason: 'x' }])).toBe('eerie');
    const w = new MoodDirector(['boss']);
    expect(w.onEvents([{ type: 'game_over', result: 'won', reason: 'x' }])).toBe('upbeat');
  });

  it('reads mood from GM actions', () => {
    expect(moodFromGmActions([{ type: 'narrate', text: 'x' }, { type: 'mood', music: 'eerie' }, { type: 'mood', music: 'boss' }])).toBe('boss');
    expect(moodFromGmActions([{ type: 'mood', music: 'disco' }])).toBeNull();
    expect(moodFromGmActions([null, 3, 'mood'])).toBeNull();
  });
});
