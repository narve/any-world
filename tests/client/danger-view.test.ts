/**
 * Danger feedback (audit "Danger feedback when a vital resource is empty or low"): an empty vital
 * that hurts is flagged as draining, its bar is marked low and shows its full name, and the quick
 * slot holding a known item that restores it is marked urgent ("press N").
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { restoresOf } from '../../src/client/view';
import { loadFixture, roomMap } from '../engine/helpers';

const ship = loadFixture('fixture-ship.json');
const western = loadFixture('fixture-western.json');

function shipSession() {
  const s = new GameSession({ world: ship, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10) });
  const st = structuredClone(s.state) as GameState;
  st.knowledge['o2-canister'] = { ...st.knowledge['o2-canister'], level: 'clear' };
  s.state = st;
  return s;
}

describe('danger view', () => {
  it('no danger at full health and air', () => {
    expect(shipSession().viewModel().game!.hud.danger).toEqual([]);
  });

  it('empty O2 drains health and points at the canister slot', () => {
    const s = shipSession();
    const st = structuredClone(s.state) as GameState;
    st.player.resources.oxygen = 0;
    s.state = st;
    const g = s.viewModel().game!;
    const slot = g.slots.findIndex((x, i) => i < 8 && x?.defId === 'o2-canister');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(g.hud.danger?.[0]).toMatchObject({ id: 'oxygen', level: 'empty', draining: true, slot });
    expect(g.slots[slot]!.urgent).toBe(true);
    expect(g.hud.resources.find((r) => r.id === 'oxygen')!.low).toBe(true);
  });

  it('low health is a danger; a resource that only runs out (no harm) is not', () => {
    const s = new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10) });
    const st = structuredClone(s.state) as GameState;
    const p = st.area.actors.find((a) => a.id === st.player.actorId)!;
    p.hp = 1;
    for (const r of western.resources) st.player.resources[r.id] = 0;
    s.state = st;
    const d = s.viewModel().game!.hud.danger!;
    expect(d.map((x) => x.id)).toEqual(['hp']);
  });

  it('unknown items never reveal what they restore', () => {
    const s = new GameSession({ world: ship, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10) });
    const st = structuredClone(s.state) as GameState;
    st.knowledge['o2-canister'] = { ...st.knowledge['o2-canister'], level: 'unknown' };
    st.player.resources.oxygen = 0;
    s.state = st;
    const g = s.viewModel().game!;
    expect(g.slots.find((x) => x?.defId === 'o2-canister')?.restores).toBeUndefined();
    expect(g.hud.danger?.[0].slot).toBeUndefined();
    expect(restoresOf(ship.items.find((i) => i.id === 'o2-canister')!)).toEqual(['oxygen']);
  });
});
