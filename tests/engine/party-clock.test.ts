/**
 * World clocks run slower in a party (owner, 2026-10-30, MULTIPLAYER-PLAN §6 O1): a party run takes more
 * turns, so rule triggers that fire every N turns, per-turn resource drains and `turn` conditions are
 * stretched by worldClockFactor (1 + 0.06·(n − 1)). A party of one is unchanged (golden replay).
 */
import { describe, it, expect } from 'vitest';
import { testWorld, newGame, act, ctxFor } from './helpers';
import { PARTY_SCALING, leadPlayer } from '../../src/engine';
import { worldClockFactor } from '../../src/engine/difficulty';
import { evalCondition } from '../../src/engine/conditions';
import type { GameState } from '../../src/engine/types';

/** the area's party size, as the engine sets it when it builds an area for a party */
function withParty(s: GameState, n: number): GameState {
  if (n > 1) s.area.partySize = n;
  return s;
}

describe('world clocks in a party', () => {
  it('the factor: 1 for a party of one, 1.06 for two, about 1.66 for twelve', () => {
    expect(PARTY_SCALING.worldClock).toBe(0.06);
    expect(worldClockFactor({ area: {} })).toBe(1);
    expect(worldClockFactor({ area: { partySize: 2 } })).toBeCloseTo(1.06);
    expect(worldClockFactor({ area: { partySize: 12 } })).toBeCloseTo(1.66);
  });

  it('a rule that fires every 15 turns fires every 25 in a party of twelve', () => {
    const w = testWorld((x) => {
      x.resources![0].start = 0;
      x.rules = [
        {
          id: 'creep',
          name: 'Creep',
          description: 'oil seeps in',
          playerTriggers: [{ on: 'on_turn', every: 15, action: { targeting: { shape: 'self', affects: 'self_only' }, effects: [{ type: 'resource', resource: 'oil', amount: { base: 1 } }] } }],
        },
      ] as never;
    });
    const firedAt = (n: number): number[] => {
      let s = withParty(newGame(w), n);
      const at: number[] = [];
      let last = leadPlayer(s).resources.oil ?? 0;
      for (let i = 0; i < 52; i++) {
        s = act(w, s, { type: 'wait' }).state;
        const now = leadPlayer(s).resources.oil ?? 0;
        if (now !== last) at.push(s.turn);
        last = now;
      }
      return at;
    };
    const solo = firedAt(1);
    const party = firedAt(12);
    expect(solo.length).toBeGreaterThanOrEqual(3);
    expect(solo[1] - solo[0]).toBe(15);
    expect(party.length).toBe(2);
    expect(party[1] - party[0]).toBe(25);
  });

  it('a per-turn drain skips turns: about 1 in the factor, in whole amounts', () => {
    const w = testWorld((x) => {
      x.resources![0].perTurn = -1;
      x.resources![0].start = 20;
    });
    const after = (n: number) => {
      let s = withParty(newGame(w), n);
      for (let i = 0; i < 6; i++) s = act(w, s, { type: 'wait' }).state;
      return leadPlayer(s).resources.oil ?? 0;
    };
    expect(after(1)).toBe(14);
    // 6 turns: the drain lands on about 1 turn in 1.66, in whole steps (3 or 4 of the 6)
    expect([16, 17]).toContain(after(12));
    expect(Number.isInteger(after(12))).toBe(true);
  });

  it('a `turn ≥ T` condition waits for T × the factor', () => {
    const w = testWorld();
    const s = newGame(w);
    s.turn = 120;
    const c = { type: 'turn', cmp: 'gte', value: 100 } as const;
    expect(evalCondition(ctxFor(w, s), c)).toBe(true);
    withParty(s, 12);
    expect(evalCondition(ctxFor(w, s), c)).toBe(false);
    s.turn = 166;
    expect(evalCondition(ctxFor(w, s), c)).toBe(true);
  });
});
