/**
 * M5 regression (issues/M5-talker-circles-npc.md): a bot that flip-flops between two navigation
 * targets must still give up on them, instead of circling until the runner calls the run stuck.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture, testWorld, newGame, addActor } from '../engine/helpers';
import { newMemory, trackProgress } from '../../src/engine/sim/bots';
import { botCtx, lootCarriers } from '../../src/engine/sim/view';
import { runGame } from '../../src/engine/sim/run';

describe('navigation target progress', () => {
  it('gives up on a target pursued without getting closer, as before', () => {
    const mem = newMemory(1);
    let gaveUp = -1;
    for (let d = 1; d <= 60 && gaveUp < 0; d++) {
      mem.decisions = d;
      if (!trackProgress(mem, 42, 5)) gaveUp = d;
    }
    expect(gaveUp).toBeGreaterThan(20);
    expect(gaveUp).toBeLessThanOrEqual(30);
  });

  it('keeps a target while the bot gets closer', () => {
    const mem = newMemory(1);
    for (let d = 1; d <= 80; d++) {
      mem.decisions = d;
      expect(trackProgress(mem, 'a7', 100 - d)).toBe(true);
    }
    expect(mem.target).toEqual({ key: 'a7', best: 20, since: 80 });
  });

  it('two see-sawing targets (costs shift as hostiles move) wear each other out instead of resetting', () => {
    const mem = newMemory(1);
    // the 7-move cycle of the seed-67 trace: 4 decisions toward one frontier tile, 3 toward the other
    const cycle: [number, number][] = [[1210, 12], [1210, 7], [600, 8], [600, 16], [600, 15], [1210, 9], [1210, 13]];
    const gaveUp = new Set<number>();
    for (let d = 1; d <= 400 && gaveUp.size < 2; d++) {
      mem.decisions = d;
      const [key, cost] = cycle[d % cycle.length];
      if (gaveUp.has(key)) continue;
      if (!trackProgress(mem, key, cost)) gaveUp.add(key);
    }
    expect([...gaveUp].sort()).toEqual([1210, 600]);
  });

  it('a target another target replaced for a while starts over when picked again', () => {
    const mem = newMemory(1);
    for (let d = 1; d <= 20; d++) {
      mem.decisions = d;
      expect(trackProgress(mem, 3, 2)).toBe(true);
    }
    // a long detour to another target, then back from much further away
    for (let d = 21; d <= 39; d++) {
      mem.decisions = d;
      expect(trackProgress(mem, 9, 60 - d)).toBe(true);
    }
    for (let d = 40; d <= 60; d++) {
      mem.decisions = d;
      expect(trackProgress(mem, 3, 30)).toBe(true);
    }
  });

  it('the patience clock keeps running while the bot rests or fights with the same target in mind', () => {
    const mem = newMemory(1);
    mem.decisions = 1;
    expect(trackProgress(mem, 464, 4)).toBe(true);
    // ~40 decisions of resting (navigate not consulted), then the same target, no closer
    mem.decisions = 40;
    expect(trackProgress(mem, 464, 4)).toBe(false);
  });

  it('a hostile carrying a needed item is worth defeating until a copy is in reach', () => {
    const world = testWorld();
    const s = newGame(world);
    s.player.slots = s.player.slots.map((it) => (it?.defId === 'tonic' ? null : it));
    addActor(world, s, 'archer', { x: 6, y: 5 });
    addActor(world, s, 'sage', { x: 3, y: 3 });
    const want = new Set(['tonic']);
    expect([...lootCarriers(botCtx(world, s), want)]).toEqual(['archer']);
    expect(lootCarriers(botCtx(world, s), new Set())).toEqual(new Set());
    s.area.items.push({ item: { id: 'i900', defId: 'tonic', count: 1 }, pos: { x: 2, y: 2 } });
    expect(lootCarriers(botCtx(world, s), want).size).toBe(0);
  });

  it('cyberpunk-rooftop-yams seed 15: the talker fights the boss carrying the lock item', { timeout: 60_000 }, () => {
    const r = runGame(loadFixture('cyberpunk-rooftop-yams.json'), 15, 'talker', { fast: true });
    expect(r.result, r.cause).not.toBe('stuck');
  });

  it('corporate-merger-kitchen seed 67: the talker no longer circles in area 2', { timeout: 60_000 }, () => {
    for (const f of ['corporate-merger-kitchen.json', 'corporate-merger-kitchen-nb.json']) {
      const r = runGame(loadFixture(f), 67, 'talker', { fast: true });
      expect(r.result, `${f}: ${r.cause}`).not.toBe('stuck');
      expect(r.areaReached, f).toBeGreaterThan(2);
      expect(r.stats.invalidLegal).toBe(0);
    }
  });
});
