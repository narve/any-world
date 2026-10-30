/**
 * MP1 B2b: falling in a party. Each player's first fall on Gentle and Normal is a second chance;
 * after it (and from the first fall on Hard and Brutal) the player is down: hp 0, no upkeep, no
 * energy. A standing teammate next to them gets them up after one round, or they get up alone
 * after 20; empty fatal resources are refilled. The run is lost only when everyone is down. A
 * party of one plays as before.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import { createGame, stepTurn } from '../../src/engine';
import { indexWorld, withPlayer, type Ctx } from '../../src/engine/ctx';
import { giveItem } from '../../src/engine/inventory';
import { dealDamage, killPlayer } from '../../src/engine/combat';
import { ACT_COST, REVIVE_SELF_TURNS, canTakeTurn } from '../../src/engine/turn';
import { rngFromState } from '../../src/engine/rng';
import { invariantError } from '../../src/engine/sim/run';
import type { Difficulty } from '../../src/schema/gm';
import type { GameState, PlayerAction, PlayerId, Pos, TurnInput } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const w = testWorld();

function party(n: number, difficulty: Difficulty = 'normal', world: WorldSpec = w): GameState {
  return createGame(world, {
    seed: 4,
    difficulty,
    map: roomMap(16, 12),
    mapGenerator: simpleGenerator,
    players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid'][i] })),
  });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const ctxOf = (world: WorldSpec, s: GameState, pid: PlayerId = s.party[0]): Ctx => ({ world, ix: indexWorld(world), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const act = (pid: PlayerId, ...actions: PlayerAction[]): TurnInput => ({ playerId: pid, actions });
const turn = (s: GameState, inputs: TurnInput[], world: WorldSpec = w) => stepTurn(s, inputs, { ...env(world), advance: true });
const place = (s: GameState, at: Record<PlayerId, Pos>) => {
  for (const [pid, p] of Object.entries(at)) actorOf(s, pid).pos = { ...p };
};
/** a lethal hit on a player (test setup works on the state in place) */
const fell = (world: WorldSpec, s: GameState, pid: PlayerId) => {
  const c = ctxOf(world, s);
  dealDamage(c, actorOf(s, pid), 999, 'physical');
  return c;
};

describe('second chance and down', () => {
  it('on Normal every player of a party has one second chance, then goes down', () => {
    const s = party(2);
    fell(w, s, 'p2');
    const a = actorOf(s, 'p2');
    expect(s.players.p2.mercyUsed).toBe(true);
    expect(a.hp).toBe(Math.ceil(a.maxHp / 2));
    expect(s.players.p2.down).toBeFalsy();
    // p1's chance is its own
    fell(w, s, 'p1');
    expect(s.players.p1.mercyUsed).toBe(true);
    // p2's second fall: down
    const c = fell(w, s, 'p2');
    expect(s.players.p2.down).toEqual({ since: s.turn, helpedTurns: 0 });
    expect(a.hp).toBe(0);
    expect(a.energy).toBe(0);
    expect(s.status).toBe('playing');
    expect(c.events.some((e) => e.type === 'downed' && e.playerId === 'p2')).toBe(true);
    expect(s.log.some((l) => l.key === 'log.party.down')).toBe(true);
    expect(invariantError(w, s)).toBeNull();
  });

  it('on Hard the first fall is a down; Gentle gives the second chance too', () => {
    const h = party(2, 'hard');
    fell(w, h, 'p1');
    expect(h.players.p1.down).toBeTruthy();
    expect(h.players.p1.mercyUsed).toBeFalsy();
    const g = party(2, 'gentle');
    fell(w, g, 'p1');
    expect(g.players.p1.down).toBeFalsy();
    expect(g.players.p1.mercyUsed).toBe(true);
  });

  it('a second hit on a down player changes nothing', () => {
    const s = party(2, 'hard');
    fell(w, s, 'p2');
    const since = s.players.p2.down!.since;
    s.turn += 3;
    const c = ctxOf(w, s);
    killPlayer(c, actorOf(s, 'p2'), undefined);
    expect(s.players.p2.down!.since).toBe(since);
    expect(s.players.p2.mercyUsed).toBeFalsy();
    expect(dealDamage(c, actorOf(s, 'p2'), 5, 'physical')).toBe(0);
  });

  it('the run is lost only when everyone is down', () => {
    const s = party(3, 'brutal');
    fell(w, s, 'p1');
    fell(w, s, 'p3');
    expect(s.status).toBe('playing');
    const c = ctxOf(w, s);
    const rat = addActor(w, s, 'rat', { x: 5, y: 5 });
    dealDamage(c, actorOf(s, 'p2'), 999, 'physical', rat.id);
    expect(s.status).toBe('lost');
    expect(s.endReasonKey).toMatch(/^end\.loss\.by/);
    expect(s.endReasonParams?.by).toBe('Rat');
  });

  it('a party of one on Normal still loses at the first fall, and Gentle still saves once', () => {
    const s = party(1);
    fell(w, s, 'p1');
    expect(s.status).toBe('lost');
    expect(s.players.p1.down).toBeFalsy();
    const g = party(1, 'gentle');
    fell(w, g, 'p1');
    expect(g.status).toBe('playing');
    fell(w, g, 'p1');
    expect(g.status).toBe('lost');
  });

  it('a down player is refused, has no legal actions and is not in readyPlayers', async () => {
    const { legalActions, readyPlayers } = await import('../../src/engine');
    const s = party(2, 'hard');
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 13, y: 9 } });
    fell(w, s, 'p2');
    expect(legalActions(s, { ...env(w), playerId: 'p2' })).toEqual([]);
    const r = turn(s, [act('p2', { type: 'wait' }), act('p1', { type: 'wait' })]);
    expect(r.outcomes[0]).toMatchObject({ ok: false, reason: 'down' });
    expect(readyPlayers(r.state, env(w))).not.toContain('p2');
  });
});

describe('down players skip upkeep', () => {
  const drain = testWorld((wi) => {
    wi.resources = [{ id: 'oil', name: 'Oil', description: 'lamp oil', color: '#ffaa00', max: 20, start: 10, perTurn: -1, onEmpty: [{ type: 'apply_status', status: 'blind', duration: 3 }] }];
  });

  it('no drain, no regen, no energy while down', () => {
    const s = party(2, 'hard', drain);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 12, y: 9 } });
    fell(drain, s, 'p2');
    let st = s;
    for (let i = 0; i < 5; i++) st = turn(st, [act('p1', { type: 'wait' })], drain).state;
    expect(st.players.p2.resources.oil).toBe(10);
    expect(st.players.p1.resources.oil).toBeLessThan(10);
    expect(actorOf(st, 'p2').hp).toBe(0);
    expect(actorOf(st, 'p2').energy).toBe(0);
    expect(invariantError(drain, st)).toBeNull();
  });
});

describe('getting back up', () => {
  it('a teammate next to them for one round gets them up at half health', () => {
    const s = party(2, 'hard');
    place(s, { p1: { x: 4, y: 4 }, p2: { x: 5, y: 4 } });
    fell(w, s, 'p2');
    const r = turn(s, [act('p1', { type: 'wait' })]);
    const a = actorOf(r.state, 'p2');
    expect(r.state.players.p2.down).toBeFalsy();
    expect(a.hp).toBe(Math.ceil(a.maxHp / 2));
    expect(r.events.some((e) => e.type === 'revived' && e.playerId === 'p2' && e.helped)).toBe(true);
    expect(r.state.log.some((l) => l.key === 'log.party.up')).toBe(true);
    expect(invariantError(w, r.state)).toBeNull();
  });

  it('getting up brings no burst: the energy of one action, not that plus the round gain', () => {
    const s = party(2, 'hard');
    place(s, { p1: { x: 4, y: 4 }, p2: { x: 5, y: 4 } });
    fell(w, s, 'p2');
    let r = turn(s, [act('p1', { type: 'wait' })]);
    expect(r.state.players.p2.down).toBeFalsy();
    expect(actorOf(r.state, 'p2').energy).toBeLessThanOrEqual(ACT_COST);
    // both act once, then both are ready again together (p1 is never left waiting on p2)
    r = turn(r.state, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })]);
    const c = ctxOf(w, r.state);
    expect(canTakeTurn(c, 'p1')).toBe(canTakeTurn(c, 'p2'));
  });

  it('alone they get up after 20 turns', () => {
    const s = party(2, 'hard');
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 13, y: 9 } });
    fell(w, s, 'p2');
    let st = s;
    while (st.turn - s.turn < REVIVE_SELF_TURNS - 1) st = turn(st, [act('p1', { type: 'wait' })]).state;
    expect(st.players.p2.down).toBeTruthy();
    st = turn(st, [act('p1', { type: 'wait' })]).state;
    expect(st.players.p2.down).toBeFalsy();
    expect(actorOf(st, 'p2').hp).toBeGreaterThan(0);
  });

  it('someone standing on the body: they get up on the nearest free tile', () => {
    const s = party(2, 'hard');
    place(s, { p1: { x: 4, y: 4 }, p2: { x: 5, y: 4 } });
    fell(w, s, 'p2');
    actorOf(s, 'p1').pos = { x: 5, y: 4 };
    const r = turn(s, [act('p1', { type: 'wait' })]);
    expect(r.state.players.p2.down).toBeFalsy();
    expect(actorOf(r.state, 'p2').pos).not.toEqual(actorOf(r.state, 'p1').pos);
    expect(invariantError(w, r.state)).toBeNull();
  });

  it('empty fatal resources are refilled on getting up', () => {
    const s = party(2, 'hard');
    place(s, { p1: { x: 4, y: 4 }, p2: { x: 5, y: 4 } });
    s.players.p2.resources.oil = 0;
    fell(w, s, 'p2');
    const r = turn(s, [act('p1', { type: 'wait' })]);
    expect(r.state.players.p2.resources.oil).toBe(10);
  });
});

describe('fatal resources in a party', () => {
  const air = testWorld((wi) => {
    wi.resources = [{ id: 'air', name: 'Air', description: 'breath', color: '#aaaaff', max: 20, start: 20, perTurn: -1, onEmpty: [], emptyIsDeath: true }];
  });

  it('emptyIsDeath downs the player (Hard) instead of ending the run', () => {
    const s = party(2, 'hard', air);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 13, y: 9 } });
    s.players.p2.resources.air = 1;
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })], air);
    expect(r.state.status).toBe('playing');
    expect(r.state.players.p2.down).toBeTruthy();
    expect(invariantError(air, r.state)).toBeNull();
  });

  it('on Normal it is the second chance, with the resource refilled', () => {
    const s = party(2, 'normal', air);
    s.players.p2.resources.air = 1;
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })], air);
    expect(r.state.players.p2.down).toBeFalsy();
    expect(r.state.players.p2.mercyUsed).toBe(true);
    expect(r.state.players.p2.resources.air).toBeGreaterThanOrEqual(9);
  });

  it('when the last player runs out, the loss names the resource', () => {
    const s = party(2, 'hard', air);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 13, y: 9 } });
    s.players.p1.resources.air = 1;
    s.players.p2.resources.air = 1;
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })], air);
    expect(r.state.status).toBe('lost');
    expect(r.state.endReasonKey).toBe('end.loss.resource');
  });

  it('a party of one still loses at once', () => {
    const s = party(1, 'gentle', air);
    s.players.p1.resources.air = 1;
    const r = turn(s, [act('p1', { type: 'wait' })], air);
    expect(r.state.status).toBe('lost');
    expect(r.state.endReasonKey).toBe('end.loss.resource');
  });
});

describe('downed by their own action (MP1 B4)', () => {
  it('a player who fells themselves with an item keeps the down state (no action cost below 0 energy)', () => {
    const acid = testWorld((input) => {
      const tonic = input.items.find((i) => i.id === 'tonic')!;
      input.items.push({ ...tonic, id: 'acid', name: 'Acid', onUse: { targeting: tonic.onUse!.targeting, effects: [{ type: 'damage', amount: { base: 999 }, damageType: 'physical' }] } } as never);
    });
    const s = party(2, 'hard', acid);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 13, y: 9 } });
    const c = ctxOf(acid, s, 'p2');
    withPlayer(c, 'p2', () => giveItem(c, 'acid'));
    const slot = s.players.p2.slots.findIndex((it) => it?.defId === 'acid');
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'use', slot })], acid);
    expect(r.state.players.p2.down).toBeTruthy();
    expect(actorOf(r.state, 'p2').energy).toBe(0);
    expect(invariantError(acid, r.state)).toBeNull();
  });
});
