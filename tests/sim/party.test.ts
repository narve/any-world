/**
 * MP1 B2a: the minimal party runner. Two-player bot games run to the end (or a turn cap) without
 * crashes, invariant breaks or illegal refusals, deterministically; a party of one plays the same
 * game as runGame; the injected clock gives per-turn timings (the engine reads no clock).
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from '../engine/helpers';
import { runParty } from '../../src/engine/sim/party';
import { runGame } from '../../src/engine/sim/run';

const worlds = ['fixture-ship.json', 'fixture-western.json'];

describe('runParty', () => {
  for (const f of worlds) {
    it(`${f}: two players, no crash, no invariant break, no illegal refusal, deterministic`, () => {
      const world = loadFixture(f);
      for (const seed of [1, 2]) {
        const r = runParty(world, seed, ['explorer', 'cautious'], { fast: true, maxTurns: 600 });
        expect(r.result, r.cause).not.toBe('crash');
        expect(r.anomalies).toEqual([]);
        expect(r.refusals.illegal).toBe(0);
        expect(r.partySize).toBe(2);
        expect(r.partyTurns).toBeGreaterThan(0);
        const again = runParty(world, seed, ['explorer', 'cautious'], { fast: true, maxTurns: 600 });
        expect(again).toEqual(r);
      }
    });
  }

  it('the cloning stepTurn and the in-place one play the same party game', () => {
    const world = loadFixture('fixture-ship.json');
    const a = runParty(world, 3, ['explorer', 'talker'], { maxTurns: 200 });
    const b = runParty(world, 3, ['explorer', 'talker'], { fast: true, maxTurns: 200 });
    expect(b).toEqual(a);
  });

  it('a party of one plays the same game as runGame', () => {
    const world = loadFixture('fixture-western.json');
    const solo = runGame(world, 4, 'explorer', { fast: true, maxTurns: 800 });
    const one = runParty(world, 4, ['explorer'], { fast: true, maxTurns: 800 });
    expect(one.result).toBe(solo.result);
    expect(one.turns).toBe(solo.turns);
    expect(one.areaReached).toBe(solo.areaReached);
  });

  it('an injected clock gives a time per party turn and the engine split', () => {
    const world = loadFixture('fixture-ship.json');
    let t = 0;
    const turns: number[] = [];
    const r = runParty(world, 5, ['explorer', 'cautious', 'talker'], { fast: true, maxTurns: 60, now: () => (t += 0.5), onTurn: (i) => turns.push(i.ms ?? -1) });
    expect(r.timing).toBeDefined();
    expect(r.timing!.turnMs.length).toBe(r.partyTurns);
    expect(turns).toEqual(r.timing!.turnMs);
    expect(r.timing!.turnMs.every((ms) => ms > 0)).toBe(true);
    for (const k of ['turn', 'world', 'fov']) expect(r.timing!.split[k]).toBeGreaterThan(0);
    expect(runParty(world, 5, ['explorer'], { fast: true, maxTurns: 20 }).timing).toBeUndefined();
  });
});
