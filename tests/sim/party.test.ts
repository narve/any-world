/**
 * MP1 B2a/B4: the party runner. Two- and four-player bot games run to the end (or a turn cap)
 * without crashes, invariant breaks or illegal refusals, deterministically; a party of one plays
 * the same game as runGame; bots never change the state they decide on; the injected clock gives
 * per-turn timings with the engine's share (the engine reads no clock); summaries for tools/sim.ts.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from '../engine/helpers';
import { hashState } from '../../src/engine';
import { type PartyResult, formatPartySummary, partyBots, runParty, summarizeParty, timeStats } from '../../src/engine/sim/party';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { runGame } from '../../src/engine/sim/run';
import type { GameState } from '../../src/engine/types';

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

  it('four players: no crash, no invariant break, no illegal refusal', () => {
    const world = loadFixture('fixture-western.json');
    const r = runParty(world, 1, ['explorer', 'cautious', 'talker', 'newbie'], { fast: true, maxTurns: 500 });
    expect(r.result, r.cause).not.toBe('crash');
    expect(r.anomalies).toEqual([]);
    expect(r.refusals.illegal).toBe(0);
    expect(r.partySize).toBe(4);
    expect(r.bots).toEqual(['explorer', 'cautious', 'talker', 'newbie']);
  });

  it('bots never change the state they decide on', () => {
    const world = loadFixture('fixture-ship.json');
    const states: GameState[] = [];
    runParty(world, 2, ['explorer', 'cautious', 'talker'], { maxTurns: 150, onTurn: (i) => void (i.result.state.turn % 25 === 0 && states.push(i.state)) });
    expect(states.length).toBeGreaterThan(2);
    for (const s of states)
      for (const name of ['explorer', 'cautious', 'talker', 'newbie', 'random'] as const)
        for (const pid of s.party) {
          if (s.players[pid].down) continue;
          const before = hashState(s);
          botByName(name).decide(s, world, newMemory(3), pid);
          expect(hashState(s)).toBe(before);
        }
  });

  it('Brutal: players go down and teammates get them back up; the run goes on until everyone is down (MP1 B2b, B4)', () => {
    // (B4: the bots revive on purpose; this seed has downs and revives, one of them helped)
    const world = loadFixture('fantasy-retired-mimic.json');
    let downed = 0;
    let revived = 0;
    let helped = 0;
    const r = runParty(world, 6, ['explorer', 'cautious'], {
      fast: true,
      maxTurns: 1500,
      difficulty: 'brutal',
      onTurn: (i) => {
        for (const e of i.result.events) {
          if (e.type === 'downed') downed++;
          if (e.type === 'revived') revived++;
          if (e.type === 'revived' && e.helped) helped++;
        }
      },
    });
    expect(r.result, r.cause).not.toBe('crash');
    expect(r.anomalies).toEqual([]);
    expect(downed).toBeGreaterThan(0);
    expect(revived).toBeGreaterThan(0);
    expect(helped).toBeGreaterThan(0);
    expect([r.downs, r.revives, r.helpedRevives]).toEqual([downed, revived, helped]);
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
    // the engine's share of each party turn: part of it, summing to the 'turn' key
    expect(r.timing!.engineMs.length).toBe(r.partyTurns);
    expect(r.timing!.engineMs.every((ms, i) => ms > 0 && ms <= r.timing!.turnMs[i])).toBe(true);
    expect(r.timing!.engineMs.reduce((a, b) => a + b, 0)).toBeCloseTo(r.timing!.split.turn, 6);
    expect(runParty(world, 5, ['explorer'], { fast: true, maxTurns: 20 }).timing).toBeUndefined();
  });
});

describe('party summaries (tools/sim.ts --party)', () => {
  it('partyBots cycles the bot list, rotated by the offset', () => {
    expect(partyBots(['explorer', 'cautious', 'talker'], 4)).toEqual(['explorer', 'cautious', 'talker', 'explorer']);
    expect(partyBots(['explorer', 'cautious', 'talker'], 2, 2)).toEqual(['talker', 'explorer']);
    expect(partyBots([], 2)).toEqual(['explorer', 'explorer']);
  });

  it('timeStats: mean, nearest-rank p95, max', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(timeStats(xs)).toEqual({ n: 100, mean: 50.5, p95: 95, max: 100 });
    expect(timeStats([])).toEqual({ n: 0, mean: 0, p95: 0, max: 0 });
    expect(timeStats([3])).toMatchObject({ p95: 3, max: 3 });
  });

  it('summarizeParty groups by party size and adds refusals, downs and timing', () => {
    const world = loadFixture('fixture-ship.json');
    let t = 0;
    const now = () => (t += 0.25);
    const rs: PartyResult[] = [
      runParty(world, 1, ['explorer', 'cautious'], { fast: true, maxTurns: 80, now }),
      runParty(world, 2, ['cautious', 'explorer'], { fast: true, maxTurns: 80, now }),
      runParty(world, 1, ['explorer', 'cautious', 'talker'], { fast: true, maxTurns: 80, now }),
    ];
    const sums = summarizeParty(rs, world.areas.length);
    expect(sums.map((x) => [x.partySize, x.runs])).toEqual([
      [2, 2],
      [3, 1],
    ]);
    const two = sums[0];
    expect(two.won + two.lost + two.stuck + two.crash + two.timeout).toBe(2);
    expect(two.refusals.contested).toBe(rs[0].refusals.contested + rs[1].refusals.contested);
    expect(two.timing!.turn.n).toBe(rs[0].partyTurns + rs[1].partyTurns);
    expect(two.timing!.engine.mean).toBeLessThanOrEqual(two.timing!.turn.mean);
    expect(two.timing!.bots.mean).toBeCloseTo(two.timing!.turn.mean - two.timing!.engine.mean, 6);
    const text = formatPartySummary('ship', sums);
    expect(text).toContain('== ship');
    expect(text).toMatch(/2p party turn mean/);
    expect(text).toMatch(/3p {3}engine/);
  });
});
