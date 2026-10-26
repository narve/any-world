/**
 * Signal the strong move (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §1.4): after a few turns of
 * trading blows the best ready attack item glows, a ranged weapon glows while someone hostile is in
 * its reach, the open exit glows at low health, and Persuade shows its odds.
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { attackPower } from '../../src/client/view';
import { persuadeOdds, leadPlayer } from '../../src/engine';
import { setLanguage } from '../../src/client/i18n/index';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');

function session(map = roomMap(16, 10)) {
  setLanguage('en');
  return new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map });
}

/** a clone of the state with the player at `pos`, a hostile at `foe`, and every tile visible */
function staged(s: GameSession, foe: { x: number; y: number }, defId = 'dust-coyote') {
  const st = structuredClone(s.state) as GameState;
  const p = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
  p.pos = { x: 3, y: 3 };
  const tmpl = st.area.actors.find((a) => a.id !== p.id);
  st.area.actors = [p];
  const id = 'foe-1';
  st.area.actors.push({
    ...(tmpl ?? structuredClone(p)),
    id,
    defId,
    faction: 'hostile',
    pos: { ...foe },
    hp: 30,
    maxHp: 30,
    statuses: [],
    tempMods: [],
    allyOf: undefined,
    ai: { alerted: true },
  } as never);
  leadPlayer(st).seen = new Uint8Array(leadPlayer(st).seen.length).fill(2);
  for (let i = 0; i < leadPlayer(st).slots.length; i++) {
    const it = leadPlayer(st).slots[i];
    if (it) leadPlayer(st).knowledge[it.defId] = { ...leadPlayer(st).knowledge[it.defId], level: 'clear' };
  }
  return { st, p, id };
}

const slotOf = (st: GameState, defId: string) => leadPlayer(st).slots.findIndex((it) => it?.defId === defId);

describe('strong move', () => {
  it('attack items are ranked by the damage they deal (areas count a little more)', () => {
    const shot = western.items.find((i) => i.id === 'trick-shot')!;
    const dynamite = western.items.find((i) => i.id === 'dynamite')!;
    const canteen = western.items.find((i) => i.id === 'canteen')!;
    expect(attackPower(shot)).toBeGreaterThan(9);
    expect(attackPower(dynamite)).toBeGreaterThan(attackPower(shot));
    expect(attackPower(canteen)).toBe(0);
  });

  it('after two turns of fighting someone adjacent, the best ready attack item glows', () => {
    const s = session();
    const { st } = staged(s, { x: 4, y: 3 });
    const shot = slotOf(st, 'trick-shot');
    expect(shot).toBeGreaterThanOrEqual(0);
    s.state = st;
    expect(s.viewModel().game!.slots[shot]!.urgent).toBeFalsy();
    st.turn = 10;
    st.log.push({ turn: 9, text: 'a hits b', kind: 'combat' }, { turn: 10, text: 'b hits a', kind: 'combat' });
    s.state = structuredClone(st);
    expect(s.viewModel().game!.slots[shot]!.urgent).toBe(true);
    // a fight that ended long ago does not count
    st.turn = 20;
    s.state = structuredClone(st);
    expect(s.viewModel().game!.slots[shot]!.urgent).toBeFalsy();
  });

  it('an equipped ranged weapon glows while someone hostile is in its reach but not adjacent', () => {
    const s = session();
    const { st } = staged(s, { x: 7, y: 3 });
    const gun = leadPlayer(st).equipped.weapon!;
    expect(western.items.find((i) => i.id === leadPlayer(st).slots[gun]!.defId)!.weapon!.range).toBeGreaterThan(3);
    s.state = st;
    expect(s.viewModel().game!.slots[gun]!.urgent).toBe(true);
    // out of reach: no glow
    const far = staged(s, { x: 14, y: 8 });
    s.state = far.st;
    expect(s.viewModel().game!.slots[gun]!.urgent).toBeFalsy();
  });

  it('the open exit glows at low health', () => {
    const map = roomMap(16, 10, { start: { x: 3, y: 3 }, exit: { x: 14, y: 8 } });
    const s = new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map });
    const st = structuredClone(s.state) as GameState;
    const p = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
    st.area.actors = [p];
    p.pos = { ...st.area.map.exit };
    s.state = st;
    const exitBtn = () => s.viewModel().game!.actions!.find((a) => a.id === 'exit');
    expect(exitBtn()).toBeDefined();
    expect(exitBtn()!.blocked).toBeUndefined();
    expect(exitBtn()!.urgent).toBeFalsy();
    p.hp = Math.floor(p.maxHp * 0.2);
    s.state = structuredClone(st);
    expect(exitBtn()!.urgent).toBe(true);
  });

  it('Persuade shows its odds, and the odds match the roll', () => {
    const s = session();
    const { st, id } = staged(s, { x: 4, y: 3 }, 'company-deputy');
    s.state = st;
    const odds = persuadeOdds(st, id)!;
    expect(odds).toBeGreaterThan(0);
    expect(odds).toBeLessThan(1);
    const btn = s.viewModel().game!.actions!.find((a) => a.id === 'persuade');
    expect(btn?.label).toContain(`(${Math.round(odds * 100)} %)`);
    expect(persuadeOdds(st, 'nobody')).toBeNull();
  });
});
