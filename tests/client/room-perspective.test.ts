/**
 * MP3 D2: perspective(state, pid) (src/client/room/perspective.ts). Rotating the party so `pid` is
 * first must answer every lead read for `pid` exactly as the engine's own `{ playerId }` does, change
 * nothing for a party of one, and be memoised per (state, pid).
 */
import { describe, it, expect } from 'vitest';
import { createGame, hashState, legalActions, persuadeOdds, playerSheet, stepTurn, transitionBlocker } from '../../src/engine';
import type { GameState, PlayerId } from '../../src/engine/types';
import { perspective } from '../../src/client/room/perspective';
import { loadFixture } from '../engine/helpers';

const western = loadFixture('fixture-western.json');

/** a 3-player run after some turns, so the players stand apart with their own fog */
function party(): GameState {
  let s = createGame(western, { seed: 5, players: [{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }] });
  const dirs = { p1: 'n', p2: 'e', p3: 'sw' } as const;
  for (let i = 0; i < 12; i++) {
    const inputs = s.party.map((pid) => {
      const legal = legalActions(s, { playerId: pid });
      const mv = legal.find((a) => a.type === 'move' && a.dir === dirs[pid as keyof typeof dirs]) ?? legal.find((a) => a.type === 'move') ?? { type: 'wait' as const };
      return { playerId: pid, actions: [mv] };
    });
    s = stepTurn(s, inputs, { world: western, advance: true }).state;
  }
  return s;
}

describe('perspective', () => {
  const s = party();

  it('answers legal actions, the sheet, persuade odds and the exit blocker for the given player', () => {
    for (const pid of ['p2', 'p3'] as PlayerId[]) {
      const v = perspective(s, pid);
      expect(v.party[0]).toBe(pid);
      expect(legalActions(v)).toEqual(legalActions(s, { playerId: pid }));
      expect(playerSheet(v)).toEqual(playerSheet(s, { playerId: pid }));
      expect(transitionBlocker(v)).toEqual(transitionBlocker(s, { playerId: pid }));
      for (const a of s.area.actors) expect(persuadeOdds(v, a.id)).toEqual(persuadeOdds(s, a.id, { playerId: pid }));
    }
    // the players really differ (else the test proves nothing)
    expect(legalActions(s)).not.toEqual(legalActions(s, { playerId: 'p2' }));
  });

  it('keeps the rest of the state and the engine result: only the party order differs', () => {
    const v = perspective(s, 'p3');
    expect(v.party).toEqual(['p3', 'p1', 'p2']);
    expect(v.players).toBe(s.players);
    expect(v.area).toBe(s.area);
    expect(hashState(s)).toBe(hashState(perspective(s, 'p1')));
  });

  it('is the state itself for the lead, a party of one and a player not on the map', () => {
    expect(perspective(s, 'p1')).toBe(s);
    const solo = createGame(western, { seed: 1 });
    expect(perspective(solo, solo.party[0])).toBe(solo);
    expect(perspective(s, 'p9')).toBe(s);
  });

  it('is memoised per state and player', () => {
    expect(perspective(s, 'p2')).toBe(perspective(s, 'p2'));
    expect(perspective(s, 'p2')).not.toBe(perspective(s, 'p3'));
    const copy = { ...s };
    expect(perspective(copy, 'p2')).not.toBe(perspective(s, 'p2'));
  });
});
