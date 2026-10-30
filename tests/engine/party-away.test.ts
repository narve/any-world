/**
 * MP2 C1: a room seat's character while its connection is gone. setAway: hostiles leave an away
 * player alone with no turn cap (a party of one is unchanged); leaveMap: after 2 minutes the
 * character leaves the map, its items drop where it stood, refused for the last member and when
 * every other member is down; returnToMap: back next to `near` with the hp it left with and an
 * empty pack; addPlayer `near`; unregisterWorld.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import {
  addPlayer,
  createGame,
  deserialize,
  getWorld,
  hashState,
  leaveMap,
  readyPlayers,
  registerWorld,
  returnToMap,
  serialize,
  setAway,
  stepTurn,
  unregisterWorld,
} from '../../src/engine';
import { BUSY_MAX_TURNS, isBusy } from '../../src/engine/ai';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { downPlayer } from '../../src/engine/combat';
import { rngFromState } from '../../src/engine/rng';
import { invariantError } from '../../src/engine/sim/run';
import { cheb } from '../../src/engine/util';
import type { GameEvent, GameState, PlayerAction, PlayerId, Pos, TurnInput } from '../../src/engine/types';

const w = testWorld();

function party(n: number, seed = 3): GameState {
  return createGame(w, {
    seed,
    map: roomMap(14, 12),
    mapGenerator: simpleGenerator,
    ...(n > 1 ? { players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid', 'Dee'][i] })) } : {}),
  });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId);
const byId = (s: GameState, id: string) => s.area.actors.find((a) => a.id === id)!;
const ctxOf = (s: GameState, pid: PlayerId = s.party[0]): Ctx => ({ world: w, ix: indexWorld(w), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const act = (pid: PlayerId, ...actions: PlayerAction[]): TurnInput => ({ playerId: pid, actions });
const waitAll = (s: GameState) => s.party.map((id) => act(id, { type: 'wait' }));
const turn = (s: GameState, inputs: TurnInput[]) => stepTurn(s, inputs, { ...env(w), advance: true });
const attacksOn = (events: GameEvent[], actorId: string) => events.filter((e) => e.type === 'attacked' && e.targetId === actorId);
const place = (s: GameState, at: Record<PlayerId, Pos>) => {
  for (const [pid, p] of Object.entries(at)) actorOf(s, pid)!.pos = { ...p };
};
const packCount = (s: GameState, pid: PlayerId) => s.players[pid].slots.filter(Boolean).length;

describe('setAway', () => {
  it('is pure and a no-op in a party of one, for a stranger and when nothing changes', () => {
    const solo = party(1);
    const h = hashState(solo);
    const r = setAway(solo, 'p1', true, env(w));
    expect(r.state).toBe(solo);
    expect(hashState(r.state)).toBe(h);
    expect(solo.players.p1.away).toBeUndefined();

    const s = party(2);
    expect(setAway(s, 'p9', true, env(w)).state).toBe(s);
    expect(setAway(s, 'p2', false, env(w)).state).toBe(s);
    const a = setAway(s, 'p2', true, env(w));
    expect(a.state).not.toBe(s);
    expect(s.players.p2.away).toBeUndefined();
    expect(a.state.players.p2.away).toBe(true);
    expect(setAway(a.state, 'p2', true, env(w)).state).toBe(a.state);
    const b = setAway(a.state, 'p2', false, env(w));
    expect('away' in b.state.players.p2).toBe(false);
    expect(hashState(b.state)).toBe(hashState(s));
  });

  it('hostiles leave an away player alone for BUSY_MAX_TURNS (the busy cap); back, it is a target again', () => {
    let s = party(2);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 10, y: 9 } });
    const rat = addActor(w, s, 'rat', { x: 10, y: 7 }, { ai: { alerted: true } });
    s = setAway(s, 'p2', true, env(w)).state;
    expect(s.players.p2.awaySince).toBe(s.turn);
    const p2 = actorOf(s, 'p2')!.id;
    for (let i = 0; i < BUSY_MAX_TURNS - 1; i++) {
      const r = turn(s, waitAll(s));
      expect(attacksOn(r.events, p2)).toEqual([]);
      s = r.state;
      expect(isBusy(ctxOf(s), s.players.p2)).toBe(true);
    }
    // the rat waits near p2 rather than walking off to p1
    expect(cheb(byId(s, rat.id).pos, actorOf(s, 'p2')!.pos)).toBeLessThanOrEqual(2);
    // away does not change who the turn waits for
    expect(readyPlayers(s, env(w))).toEqual(['p1', 'p2']);
    // the cap runs out: still away, but a target again
    const capped = (x: typeof s) => {
      let hit = false;
      for (let i = 0; i < 6 && !hit; i++) {
        const r = turn(x, waitAll(x));
        hit = attacksOn(r.events, p2).length > 0;
        x = r.state;
      }
      return { hit, x };
    };
    const later = capped(s);
    expect(later.hit).toBe(true);
    expect(later.x.players.p2.away).toBe(true);
    expect(isBusy(ctxOf(later.x), later.x.players.p2)).toBe(false);
    // back, it is a target at once
    const back = setAway(s, 'p2', false, env(w)).state;
    expect('awaySince' in back.players.p2).toBe(false);
    expect(capped(back).hit).toBe(true);
  });
});

describe('leaveMap and returnToMap', () => {
  it('the character leaves: items drop where it stood, out of the party, kept in players', () => {
    const s = party(3);
    const at = { ...actorOf(s, 'p2')!.pos };
    const held = s.players.p2.slots.filter(Boolean).map((it) => it!.id).sort();
    expect(held.length).toBeGreaterThan(0);
    expect(s.players.p2.equipped.weapon).not.toBeNull();
    const before = hashState(s);
    const r = leaveMap(s, 'p2', env(w));
    expect(hashState(s)).toBe(before);
    const t = r.state;
    expect(t.party).toEqual(['p1', 'p3']);
    expect(t.players.p2.left?.turn).toBe(s.turn);
    expect(actorOf(t, 'p2')).toBeUndefined();
    expect(packCount(t, 'p2')).toBe(0);
    expect(t.players.p2.equipped).toEqual({ weapon: null, armour: null, trinket: null });
    const dropped = t.area.items.filter((fi) => fi.pos.x === at.x && fi.pos.y === at.y).map((fi) => fi.item.id).sort();
    expect(dropped).toEqual(held);
    expect(invariantError(w, t)).toBeNull();
    // the game goes on without p2
    const r2 = turn(t, waitAll(t));
    expect(r2.state.status).toBe('playing');
    expect(r2.outcomes.every((o) => o.ok)).toBe(true);
    expect(invariantError(w, r2.state)).toBeNull();
    // an input from the player who left is refused
    expect(turn(t, [act('p2', { type: 'wait' })]).outcomes[0].ok).toBe(false);
  });

  it('closes its dialogue, clears hostile targets on it and hands its allies to the lead', () => {
    const s = party(2);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 8, y: 8 } });
    const sage = addActor(w, s, 'sage', { x: 9, y: 8 });
    s.players.p2.pendingChoice = { kind: 'dialogue', prompt: 'Hello', speakerId: sage.id, options: [] };
    const p2 = actorOf(s, 'p2')!;
    const rat = addActor(w, s, 'rat', { x: 8, y: 6 }, { ai: { alerted: true, targetId: p2.id } });
    const dog = addActor(w, s, 'rat', { x: 7, y: 8 }, { faction: 'player', allyOf: p2.id });
    const t = leaveMap(s, 'p2', env(w)).state;
    expect(t.players.p2.pendingChoice).toBeNull();
    expect(byId(t, rat.id).ai.targetId).toBeUndefined();
    expect(byId(t, dog.id).allyOf).toBe(actorOf(t, 'p1')!.id);
    expect(invariantError(w, t)).toBeNull();
  });

  it('is refused for the last party member and while every other member is down', () => {
    const solo = party(1);
    expect(() => leaveMap(solo, 'p1', env(w))).toThrow(/last party member/);
    const s = party(3);
    const c = ctxOf(s);
    downPlayer(c, s.players.p1, actorOf(s, 'p1')!);
    downPlayer(c, s.players.p3, actorOf(s, 'p3')!);
    expect(() => leaveMap(s, 'p2', env(w))).toThrow(/every other party member is down/);
    // a down player may leave while someone else stands
    const r = leaveMap(s, 'p1', env(w));
    expect(r.state.party).toEqual(['p2', 'p3']);
    expect(r.state.status).toBe('playing');
    expect(r.state.players.p1.down).toBeUndefined();
    expect(() => leaveMap(r.state, 'p1', env(w))).toThrow(/no player/);
    const two = leaveMap(party(2), 'p2', env(w)).state;
    expect(() => leaveMap(two, 'p1', env(w))).toThrow(/last party member/);
  });

  it('a countdown started by the leaver keeps running for the lead', () => {
    const s = party(2);
    s.area.exitCountdown = { turnsLeft: 3, by: 'p2' };
    const t = leaveMap(s, 'p2', env(w)).state;
    expect(t.area.exitCountdown).toEqual({ turnsLeft: 3, by: 'p1' });
  });

  it('returns next to `near` with the hp it left with, level and knowledge kept, an empty pack', () => {
    let s = party(3);
    const a2 = actorOf(s, 'p2')!;
    a2.hp = 7;
    a2.maxHp += 5;
    s.players.p2.level = 3;
    s.players.p2.xp = 12;
    s.players.p2.perks = ['tough'];
    s.players.p2.knowledge.murk.level = 'clear';
    actorOf(s, 'p2')!.statuses.push({ id: 'burning', turnsLeft: 4 } as never);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 6, y: 6 }, p3: { x: 11, y: 9 } });
    s = leaveMap(s, 'p2', env(w)).state;
    for (let i = 0; i < 3; i++) s = turn(s, waitAll(s)).state;
    const r = returnToMap(s, 'p2', { near: 'p3' }, env(w));
    const t = r.state;
    expect(t.party).toEqual(['p1', 'p3', 'p2']);
    expect(t.players.p2.left).toBeUndefined();
    const back = actorOf(t, 'p2')!;
    expect(back.id).toBe(a2.id);
    expect(back.hp).toBe(7);
    expect(back.maxHp).toBe(a2.maxHp);
    expect(back.statuses).toEqual([]);
    expect(cheb(back.pos, actorOf(t, 'p3')!.pos)).toBeLessThanOrEqual(3);
    expect(t.players.p2.level).toBe(3);
    expect(t.players.p2.xp).toBe(12);
    expect(t.players.p2.perks).toEqual(['tough']);
    expect(t.players.p2.knowledge.murk.level).toBe('clear');
    expect(packCount(t, 'p2')).toBe(0);
    expect(t.players.p2.seen.length).toBe(t.area.map.width * t.area.map.height);
    expect(invariantError(w, t)).toBeNull();
    expect(readyPlayers(t, env(w))).toContain('p2');
    const r2 = turn(t, waitAll(t));
    expect(r2.outcomes.every((o) => o.ok)).toBe(true);
    // the items it dropped are still where it stood
    expect(t.area.items.filter((fi) => fi.pos.x === 6 && fi.pos.y === 6).length).toBeGreaterThan(0);
  });

  it('a player who left while down comes back with at least 1 hp', () => {
    const s = party(2);
    downPlayer(ctxOf(s), s.players.p2, actorOf(s, 'p2')!);
    const t = leaveMap(s, 'p2', env(w)).state;
    const back = returnToMap(t, 'p2', { near: 'p1' }, env(w)).state;
    expect(actorOf(back, 'p2')!.hp).toBe(1);
    expect(back.players.p2.down).toBeUndefined();
    expect(invariantError(w, back)).toBeNull();
  });

  it('returnToMap refuses a player who has not left; `near` falls back to the lead', () => {
    const s = party(2);
    expect(() => returnToMap(s, 'p2', { near: 'p1' }, env(w))).toThrow(/has not left/);
    const t = leaveMap(s, 'p2', env(w)).state;
    const back = returnToMap(t, 'p2', { near: 'p7' }, env(w)).state;
    expect(cheb(actorOf(back, 'p2')!.pos, actorOf(back, 'p1')!.pos)).toBeLessThanOrEqual(3);
  });

  it('a state with a player who left saves, loads and hashes the same', () => {
    const s = leaveMap(party(3), 'p2', env(w)).state;
    const back = deserialize(w, serialize(s));
    expect(hashState(back)).toBe(hashState(s));
    expect(back.players.p2.seen.length).toBe(0);
    const t = turn(s, waitAll(s)).state;
    expect(hashState(turn(back, waitAll(back)).state)).toBe(hashState(t));
    expect(hashState(returnToMap(back, 'p2', { near: 'p1' }, env(w)).state)).toBe(hashState(returnToMap(s, 'p2', { near: 'p1' }, env(w)).state));
  });

  it('a party of one after everyone else left plays on, and the leavers can come back', () => {
    let s = party(3);
    s = leaveMap(s, 'p2', env(w)).state;
    s = leaveMap(s, 'p3', env(w)).state;
    expect(s.party).toEqual(['p1']);
    for (let i = 0; i < 3; i++) s = turn(s, waitAll(s)).state;
    expect(invariantError(w, s)).toBeNull();
    s = returnToMap(s, 'p3', { near: 'p1' }, env(w)).state;
    s = returnToMap(s, 'p2', { near: 'p1' }, env(w)).state;
    expect(s.party).toEqual(['p1', 'p3', 'p2']);
    expect(invariantError(w, s)).toBeNull();
  });
});

describe('addPlayer near, unregisterWorld', () => {
  it('a late joiner lands next to `near` (the lead without it)', () => {
    const s = party(2);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 11, y: 9 } });
    const a = addPlayer(s, { name: 'Late', near: 'p2' }, env(w));
    expect(cheb(actorOf(a.state, a.playerId)!.pos, actorOf(a.state, 'p2')!.pos)).toBeLessThanOrEqual(3);
    const b = addPlayer(s, { name: 'Late' }, env(w));
    expect(cheb(actorOf(b.state, b.playerId)!.pos, actorOf(b.state, 'p1')!.pos)).toBeLessThanOrEqual(3);
    // ids are never reused, also with a player who left
    const t = leaveMap(s, 'p2', env(w)).state;
    expect(addPlayer(t, { name: 'New' }, env(w)).playerId).toBe('p3');
  });

  it('unregisterWorld drops a world from the registry', () => {
    const ww = testWorld((x) => {
      x.meta.title = 'Closed Room World';
    });
    const id = registerWorld(ww);
    expect(getWorld(id)).toBe(ww);
    expect(unregisterWorld(id)).toBe(true);
    expect(getWorld(id)).toBeUndefined();
    expect(unregisterWorld(id)).toBe(false);
  });
});
