/**
 * MP1 B1: hashState, the 64-bit fingerprint of a whole GameState (canonical walk, players in party
 * order, fog as bytes whatever its form, a fixed-order tile walker).
 */
import { describe, it, expect } from 'vitest';
import { loadFixture, roomMap } from './helpers';
import { addPlayer, createGame, deserialize, hashState, serialize, step, legalActions } from '../../src/engine';
import { cloneState } from '../../src/engine/clone';
import { fastStep } from '../../src/engine/sim/fast';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import type { GameState } from '../../src/engine/types';

const ship = loadFixture('fixture-ship.json');

function twoPlayers(): GameState {
  const s = createGame(ship, { seed: 6, map: roomMap(14, 10) });
  return addPlayer(s, { name: 'Bea' }, { world: ship }).state;
}

describe('hashState', () => {
  it('is 16 hex chars and stable for the same state', () => {
    const s = twoPlayers();
    const h = hashState(s);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashState(s)).toBe(h);
    expect(hashState(structuredClone(s))).toBe(h);
  });

  it('equal for cloneState and a save round trip', () => {
    const s = twoPlayers();
    expect(hashState(cloneState(s).state)).toBe(hashState(s));
    expect(hashState(deserialize(ship, serialize(s)))).toBe(hashState(s));
  });

  it('fog hashes as bytes: Uint8Array and number[] agree', () => {
    const s = twoPlayers();
    const t = structuredClone(s);
    (t.players.p2 as { seen: number[] | Uint8Array }).seen = Array.from(t.players.p2.seen);
    (t.players.p1 as { seen: number[] | Uint8Array }).seen = Array.from(t.players.p1.seen);
    expect(hashState(t)).toBe(hashState(s));
  });

  it('does not depend on key order or on undefined fields', () => {
    const s = twoPlayers();
    const t = structuredClone(s);
    const a = t.area.actors[0];
    t.area.actors[0] = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    t.players = { p2: t.players.p2, p1: t.players.p1 };
    (t as { endReason?: string }).endReason = undefined;
    expect(hashState(t)).toBe(hashState(s));
  });

  it('differs after any change: a tile, an item, a flag, one player\'s fog, the party order', () => {
    const base = hashState(twoPlayers());
    const mut: ((s: GameState) => void)[] = [
      (s) => (s.area.map.tiles[20] = { ...s.area.map.tiles[20], terrain: 'x' }),
      (s) => (s.area.map.tiles[21] = { ...s.area.map.tiles[21], interacted: true }),
      (s) => {
        const slot = s.players.p1.slots.findIndex((x) => x);
        s.players.p1.slots[slot]!.count += 1;
      },
      (s) => (s.flags.door = true),
      (s) => (s.players.p2.seen[7] = 1),
      (s) => (s.players.p2.name = 'Cy'),
      (s) => s.party.reverse(),
      (s) => (s.purse += 1),
      (s) => s.log.push({ turn: 0, text: 'x', kind: 'info' }),
    ];
    const seen = new Set<string>([base]);
    for (const m of mut) {
      const s = twoPlayers();
      m(s);
      const h = hashState(s);
      expect(h).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(mut.length + 1);
  });

  it('step and fastStep produce states with equal hashes', () => {
    let a = createGame(ship, { seed: 3 });
    let b = structuredClone(a);
    const bot = botByName('explorer');
    const mem = newMemory(3);
    for (let i = 0; i < 120 && a.status === 'playing'; i++) {
      const action = i % 9 === 8 ? legalActions(a, { world: ship })[0] : bot.decide(a, ship, mem);
      a = step(a, action, { world: ship }).state;
      b = fastStep(b, action, ship).state;
      if (i % 30 === 0) expect(hashState(b)).toBe(hashState(a));
    }
    expect(hashState(b)).toBe(hashState(a));
  });

  it('costs well under 20 ms for a 12-player party on a 91×65 area', () => {
    const s = createGame(ship, { seed: 8, map: roomMap(91, 65), players: Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}` })) });
    for (const id of s.party) {
      const seen = s.players[id].seen;
      for (let k = 0; k < seen.length; k += 3) seen[k] = k % 2 ? 1 : 2;
    }
    hashState(s);
    const n = 10;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) hashState(s);
    const ms = (performance.now() - t0) / n;
    expect(ms).toBeLessThan(20);
  });
});
