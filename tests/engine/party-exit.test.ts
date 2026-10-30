/**
 * MP1 B3: area exits in a party. The first player to take the exit starts a countdown
 * (partyRules.exitCountdownTurns rounds, default 5) and everyone is pulled along when it ends, or
 * as soon as every standing player is at the exit. Down players arrive standing. A party of one
 * (or a party already gathered at the exit) moves on at once, as before parties.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import { DEFAULT_EXIT_COUNTDOWN_TURNS, createGame, step, stepTurn } from '../../src/engine';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { dealDamage } from '../../src/engine/combat';
import { bfsDistances } from '../../src/engine/path';
import { rngFromState } from '../../src/engine/rng';
import { invariantError } from '../../src/engine/sim/run';
import type { Difficulty } from '../../src/schema/gm';
import type { GameState, PlayerAction, PlayerId, Pos, TurnInput } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

/** the test world without the key lock on area 0, an on_area_enter trigger on the ring */
const w = testWorld((x) => {
  delete x.areas[0].transitionRequires;
  const ring = x.items.find((i) => i.id === 'ring')!;
  ring.triggers = [{ on: 'on_area_enter', action: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false }, effects: [{ type: 'apply_status', status: 'mute', duration: 30 }] } }];
  x.player.startingItems.push({ item: 'ring', equipped: true });
});
const locked = testWorld();

function party(n: number, opts: { difficulty?: Difficulty; world?: WorldSpec; exitCountdownTurns?: number } = {}): GameState {
  return createGame(opts.world ?? w, {
    seed: 3,
    difficulty: opts.difficulty ?? 'normal',
    map: roomMap(16, 12),
    mapGenerator: simpleGenerator,
    players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid', 'Dee'][i] })),
    ...(opts.exitCountdownTurns ? { exitCountdownTurns: opts.exitCountdownTurns } : {}),
  });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const ctxOf = (world: WorldSpec, s: GameState): Ctx => ({ world, ix: indexWorld(world), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const act = (pid: PlayerId, ...actions: PlayerAction[]): TurnInput => ({ playerId: pid, actions });
const turn = (s: GameState, inputs: TurnInput[], world: WorldSpec = w) => stepTurn(s, inputs, { ...env(world), advance: true });
const place = (s: GameState, at: Record<PlayerId, Pos>) => {
  for (const [pid, p] of Object.entries(at)) actorOf(s, pid).pos = { ...p };
};
const far = { x: 2, y: 2 };
const waitAll = (s: GameState) => s.party.map((id) => act(id, { type: 'wait' }));

/** p1 on the exit, the others far away; p1 takes the exit (on a turn where p1 resolves first) */
function startCountdown(s: GameState): ReturnType<typeof turn> {
  const exit = s.area.map.exit;
  place(s, { p1: exit });
  s.party.slice(1).forEach((id, i) => place(s, { [id]: { x: far.x + i, y: far.y } }));
  return turn(s, [act('p1', { type: 'transition' }), ...s.party.slice(1).map((id) => act(id, { type: 'wait' }))]);
}

describe('exit countdown', () => {
  it('a single player moves on at once, as before', () => {
    const s = createGame(w, { seed: 3, map: roomMap(16, 12), mapGenerator: simpleGenerator });
    s.area.actors.find((a) => a.id === s.players.p1.actorId)!.pos = { ...s.area.map.exit };
    const r = step(s, { type: 'transition' }, env(w));
    expect(r.tookTurn).toBe(true);
    expect(r.state.area.index).toBe(1);
    expect(r.state.area.exitCountdown).toBeUndefined();
    expect(r.state.area.partySize).toBeUndefined();
    expect(r.events.some((e) => e.type === 'exit_countdown')).toBe(false);
  });

  it('starts the countdown when teammates are elsewhere, counts it down and pulls everyone along at 0', () => {
    let s = party(2);
    const r = startCountdown(s);
    expect(r.outcomes.every((o) => o.ok)).toBe(true);
    s = r.state;
    expect(s.area.index).toBe(0);
    expect(s.area.exitCountdown).toEqual({ turnsLeft: DEFAULT_EXIT_COUNTDOWN_TURNS - 1, by: 'p1' });
    expect(r.events.filter((e) => e.type === 'exit_countdown').map((e) => (e as { turnsLeft: number }).turnsLeft)).toEqual([5, 4]);
    expect(s.log.some((l) => l.key === 'log.party.exit_countdown' && l.params?.player === 'Ann' && l.params?.turns === 5)).toBe(true);
    expect(invariantError(w, s)).toBeNull();
    // the others play on meanwhile
    for (let left = 3; left >= 1; left--) {
      const t = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'move', dir: 's' })]);
      expect(t.outcomes.every((o) => o.ok)).toBe(true);
      s = t.state;
      expect(s.area.exitCountdown?.turnsLeft).toBe(left);
      expect(invariantError(w, s)).toBeNull();
    }
    const end = turn(s, waitAll(s));
    s = end.state;
    expect(s.area.index).toBe(1);
    expect(s.area.exitCountdown).toBeUndefined();
    expect(s.stats.areasCleared).toBe(1);
    expect(end.events.some((e) => e.type === 'area_entered' && e.index === 1)).toBe(true);
    expect(actorOf(s, 'p1').pos).toEqual(s.area.map.start);
    for (const id of s.party) expect(actorOf(s, id).energy).toBeGreaterThanOrEqual(100);
    expect(invariantError(w, s)).toBeNull();
  });

  it('taking the exit again while it runs spends the turn without restarting it', () => {
    let s = startCountdown(party(2)).state;
    const r = turn(s, [act('p1', { type: 'transition' }), act('p2', { type: 'wait' })]);
    expect(r.outcomes[0]).toMatchObject({ ok: true, tookTurn: true });
    s = r.state;
    expect(s.area.exitCountdown).toEqual({ turnsLeft: 3, by: 'p1' });
    expect(s.log.filter((l) => l.key === 'log.party.exit_countdown')).toHaveLength(1);
  });

  it('the party moves on early once every standing player is at the exit', () => {
    let s = startCountdown(party(2)).state;
    const exit = s.area.map.exit;
    // p2 steps next to the exit: the round ends with everyone there, and the party moves on
    place(s, { p2: { x: exit.x - 2, y: exit.y } });
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'move', dir: 'e' })]);
    expect(r.outcomes.every((o) => o.ok)).toBe(true);
    expect(r.state.area.index).toBe(1);
    expect(invariantError(w, r.state)).toBeNull();
  });

  it('a transition with every other standing player at the exit moves on at once; later inputs are refused', () => {
    let s = party(3);
    const exit = s.area.map.exit;
    place(s, { p1: exit, p2: { x: exit.x - 1, y: exit.y }, p3: { x: exit.x, y: exit.y - 1 } });
    // a turn where p1 resolves first (rotation by turn)
    if (s.turn % 3 !== 0) s = turn(s, waitAll(s)).state;
    while (s.turn % 3 !== 0) s = turn(s, waitAll(s)).state;
    place(s, { p1: exit, p2: { x: exit.x - 1, y: exit.y }, p3: { x: exit.x, y: exit.y - 1 } });
    const r = turn(s, [act('p1', { type: 'transition' }), act('p2', { type: 'wait' }), act('p3', { type: 'wait' })]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'area changed' });
    expect(r.outcomes[2]).toMatchObject({ ok: false, reason: 'area changed' });
    expect(r.state.area.index).toBe(1);
    expect(r.state.area.exitCountdown).toBeUndefined();
  });

  it('the countdown keeps running when its starter goes down; the starter arrives standing on the start', () => {
    let s = startCountdown(party(2, { difficulty: 'hard' })).state;
    dealDamage(ctxOf(w, s), actorOf(s, 'p1'), 999, 'physical');
    expect(s.players.p1.down).toBeTruthy();
    expect(s.status).toBe('playing');
    for (let i = 0; i < 4 && s.area.index === 0; i++) s = turn(s, [act('p2', { type: 'wait' })]).state;
    expect(s.area.index).toBe(1);
    expect(s.players.p1.down).toBeFalsy();
    const a1 = actorOf(s, 'p1');
    expect(a1.pos).toEqual(s.area.map.start);
    expect(a1.hp).toBe(Math.ceil(a1.maxHp / 2));
    expect(invariantError(w, s)).toBeNull();
  });

  it('down players are pulled along and arrive standing at half health, fatal resources refilled', () => {
    let s = party(2, { difficulty: 'hard' });
    const exit = s.area.map.exit;
    place(s, { p1: exit, p2: far });
    dealDamage(ctxOf(w, s), actorOf(s, 'p2'), 999, 'physical');
    expect(s.players.p2.down).toBeTruthy();
    s.players.p2.resources.oil = 0;
    // nobody else is standing: the exit is taken at once
    const r = turn(s, [act('p1', { type: 'transition' })]);
    expect(r.outcomes[0].ok).toBe(true);
    s = r.state;
    expect(s.area.index).toBe(1);
    expect(s.players.p2.down).toBeFalsy();
    const a2 = actorOf(s, 'p2');
    expect(a2.hp).toBe(Math.ceil(a2.maxHp / 2));
    expect(s.players.p2.resources.oil).toBe(10);
    expect(r.events.some((e) => e.type === 'revived' && e.playerId === 'p2' && !e.helped)).toBe(true);
    expect(s.players.p2.mercyUsed).toBeFalsy();
    expect(invariantError(w, s)).toBeNull();
  });

  it('everyone lands on distinct, reachable floor near the start, allies next to their owner', () => {
    let s = party(4);
    // an ally of p3, standing next to p3
    s = startCountdown(s).state;
    const a3 = actorOf(s, 'p3');
    const sage = { ...actorOf(s, 'p1'), id: 'a900', defId: 'sage', faction: 'friendly' as const, allyOf: a3.id, pos: { x: a3.pos.x, y: a3.pos.y + 1 }, statuses: [], tempMods: [], ai: { alerted: false } };
    s.area.actors.push(sage);
    while (s.area.index === 0) s = turn(s, waitAll(s)).state;
    const map = s.area.map;
    const d = bfsDistances(map.width, map.height, map.start, (x, y) => ['floor', 'start', 'transition', 'door', 'door_open'].includes(map.tiles[y * map.width + x].kind));
    const posKeys = new Set<string>();
    for (const id of s.party) {
      const p = actorOf(s, id).pos;
      expect(d[p.y * map.width + p.x]).toBeGreaterThanOrEqual(0);
      expect(d[p.y * map.width + p.x]).toBeLessThanOrEqual(6);
      posKeys.add(`${p.x},${p.y}`);
    }
    expect(posKeys.size).toBe(4);
    const ally = s.area.actors.find((a) => a.id === 'a900')!;
    expect(ally).toBeDefined();
    expect(Math.max(Math.abs(ally.pos.x - actorOf(s, 'p3').pos.x), Math.abs(ally.pos.y - actorOf(s, 'p3').pos.y))).toBeLessThanOrEqual(4);
    expect(invariantError(w, s)).toBeNull();
  });

  it('on_area_enter fires once, with the starter as user', () => {
    let s = party(2);
    // p2 starts it this time
    const exit = s.area.map.exit;
    place(s, { p2: exit, p1: far });
    if (s.turn % 2 === 0) s = turn(s, waitAll(s)).state;
    place(s, { p2: exit, p1: far });
    // (the lead got the ring's status on entering area 0)
    for (const id of s.party) actorOf(s, id).statuses = [];
    s = turn(s, [act('p2', { type: 'transition' }), act('p1', { type: 'wait' })]).state;
    expect(s.area.exitCountdown?.by).toBe('p2');
    while (s.area.index === 0) s = turn(s, waitAll(s)).state;
    expect(actorOf(s, 'p2').statuses.some((st) => st.id === 'mute')).toBe(true);
    expect(actorOf(s, 'p1').statuses.some((st) => st.id === 'mute')).toBe(false);
    expect(actorOf(s, 'p2').pos).toEqual(s.area.map.start);
  });

  it('a dialogue with someone left behind closes on arrival', () => {
    let s = startCountdown(party(2)).state;
    const a2 = actorOf(s, 'p2');
    const sage = addActor(w, s, 'sage', { x: a2.pos.x, y: a2.pos.y + 1 });
    s.players.p2.pendingChoice = { kind: 'dialogue', prompt: 'p', speakerId: sage.id, options: [{ label: 'ok', actions: [] }] };
    s = turn(s, [act('p1', { type: 'wait' })]).state;
    expect(s.players.p2.pendingChoice?.speakerId).toBe(sage.id);
    while (s.area.index === 0) s = turn(s, [act('p1', { type: 'wait' })]).state;
    expect(s.players.p2.pendingChoice).toBeNull();
    expect(s.log.some((l) => l.key === 'log.party.talk_gone' && l.params?.player === 'Bea')).toBe(true);
  });

  it('the lock is checked against the party: a key in a teammate’s pack opens the way', () => {
    const s = party(2, { world: locked });
    place(s, { p1: s.area.map.exit, p2: far });
    const r = turn(s, [act('p1', { type: 'transition' })], locked);
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    const slot = s.players.p2.slots.findIndex((x) => !x);
    s.players.p2.slots[slot] = { id: 'i900', defId: 'key', count: 1 };
    const r2 = turn(s, [act('p1', { type: 'transition' })], locked);
    expect(r2.outcomes[0].ok).toBe(true);
    expect(r2.state.area.exitCountdown?.by).toBe('p1');
  });

  it('honours a custom exitCountdownTurns', () => {
    let s = party(2, { exitCountdownTurns: 2 });
    expect(s.partyRules.exitCountdownTurns).toBe(2);
    s = startCountdown(s).state;
    expect(s.area.exitCountdown?.turnsLeft).toBe(1);
    s = turn(s, waitAll(s)).state;
    expect(s.area.index).toBe(1);
  });
});
