/**
 * MP1 B2a: party turns. stepTurn resolves free actions first, then one turn action per player in
 * the rotated party order, then moves the world once; refusals carry a reason; step() is a party
 * of one going through the same code. Per-player upkeep, fog and triggers; shared xp; teammates
 * swap places; NewGameOptions.players and addPlayer.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import { addPlayer, createGame, hashState, legalActions, readyPlayers, step, stepTurn, MAX_PARTY_SIZE } from '../../src/engine';
import { resolutionOrder } from '../../src/engine/party';
import { ACT_COST } from '../../src/engine/turn';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { getStat } from '../../src/engine/stats';
import { rngFromState } from '../../src/engine/rng';
import type { AreaMap, GameState, PlayerAction, PlayerId } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const w = testWorld();

function party(n: number, opts: { world?: WorldSpec; map?: AreaMap; seed?: number } = {}): GameState {
  return createGame(opts.world ?? w, {
    seed: opts.seed ?? 1,
    map: opts.map ?? roomMap(12, 10),
    mapGenerator: simpleGenerator,
    players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid', 'Dee'][i] ?? `P${i + 1}` })),
  });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const ctxOf = (world: WorldSpec, s: GameState, pid: PlayerId = s.party[0]): Ctx => ({ world, ix: indexWorld(world), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const turn = (s: GameState, inputs: Parameters<typeof stepTurn>[1], advance = false, world: WorldSpec = w) => stepTurn(s, inputs, { ...env(world), advance });
const act = (pid: PlayerId, ...actions: PlayerAction[]) => ({ playerId: pid, actions });

describe('createGame with a party, addPlayer', () => {
  it('builds every player with an actor, a kit and the shared appearances', () => {
    const s = party(3);
    expect(s.party).toEqual(['p1', 'p2', 'p3']);
    expect(s.party.map((id) => s.players[id].name)).toEqual(['Ann', 'Bea', 'Cid']);
    const ids = new Set(s.party.map((id) => s.players[id].actorId));
    expect(ids.size).toBe(3);
    for (const id of s.party) {
      const a = actorOf(s, id);
      expect(a.hp).toBeGreaterThan(0);
      expect(s.players[id].slots.filter(Boolean).length).toBe(s.players.p1.slots.filter(Boolean).length);
      expect(s.players[id].knowledge.murk.appearance).toEqual(s.players.p1.knowledge.murk.appearance);
      expect(s.players[id].seen.length).toBe(12 * 10);
    }
    // all on distinct floor tiles; the lead on the start
    expect(actorOf(s, 'p1').pos).toEqual({ x: 1, y: 1 });
    expect(new Set(s.party.map((id) => `${actorOf(s, id).pos.x},${actorOf(s, id).pos.y}`)).size).toBe(3);
  });

  it('a party of one named like the world player is the same game as the default', () => {
    const a = createGame(w, { seed: 5, map: roomMap(), mapGenerator: simpleGenerator });
    const b = createGame(w, { seed: 5, map: roomMap(), mapGenerator: simpleGenerator, players: [{ name: w.player.name }] });
    expect(hashState(b)).toBe(hashState(a));
  });

  it('addPlayer is pure, places the newcomer next to the lead, and caps the party', () => {
    const s = party(1);
    const r = addPlayer(s, { name: 'Bea' }, env(w));
    expect(s.party).toEqual(['p1']);
    expect(r.playerId).toBe('p2');
    const a = actorOf(r.state, 'p2');
    const lead = actorOf(r.state, 'p1');
    expect(Math.max(Math.abs(a.pos.x - lead.pos.x), Math.abs(a.pos.y - lead.pos.y))).toBeLessThanOrEqual(3);
    expect(r.state.players.p2.level).toBe(1);
    expect(r.state.players.p2.seen.some((v) => v === 2)).toBe(true);
    let big = party(1, { map: roomMap(20, 12) });
    while (big.party.length < MAX_PARTY_SIZE) big = addPlayer(big, { name: `P${big.party.length + 1}` }, env(w)).state;
    expect(() => addPlayer(big, { name: 'one too many' }, env(w))).toThrow(/full/);
  });
});

describe('step is a party of one', () => {
  it('step and stepTurn with one input give the same state; a refusal returns the input state', () => {
    let s = party(1);
    for (const a of [{ type: 'move', dir: 'e' }, { type: 'wait' }, { type: 'toggle_sneak' }, { type: 'move', dir: 's' }] as PlayerAction[]) {
      const r1 = step(s, a, env(w));
      const r2 = turn(s, [act('p1', a)]);
      expect(hashState(r2.state)).toBe(hashState(r1.state));
      expect(r2.events).toEqual(r1.events);
      expect(r2.tookTurn).toBe(r1.tookTurn);
      s = r1.state;
    }
    // into the wall from the start corner
    const s0 = party(1);
    const bad = step(s0, { type: 'move', dir: 'n' }, env(w));
    expect(bad.state).toBe(s0);
    expect(bad.events).toEqual([{ type: 'invalid', reason: 'blocked' }]);
    const badTurn = turn(s0, [act('p1', { type: 'move', dir: 'n' })]);
    expect(badTurn.state).toBe(s0);
    expect(badTurn.outcomes[0]).toMatchObject({ ok: false, reason: 'illegal', detail: 'blocked' });
  });
});

describe('resolution and the world', () => {
  it('turn actions resolve in the party order rotated by the turn number', () => {
    expect(resolutionOrder(['p1', 'p2', 'p3'], 0)).toEqual(['p1', 'p2', 'p3']);
    expect(resolutionOrder(['p1', 'p2', 'p3'], 1)).toEqual(['p2', 'p3', 'p1']);
    expect(resolutionOrder(['p1', 'p2', 'p3'], 5)).toEqual(['p3', 'p1', 'p2']);
  });

  it('free actions alone do not move the world', () => {
    const s = party(2);
    const r = turn(s, [act('p1', { type: 'toggle_sneak' })]);
    expect(r.tookTurn).toBe(false);
    expect(r.state.turn).toBe(s.turn);
    expect(r.state.players.p1.sneaking).toBe(true);
    expect(actorOf(r.state, 'p1').energy).toBe(actorOf(s, 'p1').energy);
    expect(r.waited).toEqual([]);
  });

  it('advance moves an idle party: every ready player waits', () => {
    const s = party(2);
    expect(readyPlayers(s, env(w))).toEqual(['p1', 'p2']);
    const idle = turn(s, []);
    expect(idle.state).toBe(s);
    const r = turn(s, [], true);
    expect(r.tookTurn).toBe(true);
    expect(r.waited).toEqual(['p1', 'p2']);
    expect(r.state.turn).toBe(s.turn + 1);
    expect(readyPlayers(r.state, env(w))).toEqual(['p1', 'p2']);
  });

  it('a ready player who sends nothing waits while the others act', () => {
    const s = party(2);
    const r = turn(s, [act('p1', { type: 'wait' })]);
    expect(r.tookTurn).toBe(true);
    expect(r.waited).toEqual(['p2']);
    expect(r.state.turn).toBe(s.turn + 1);
  });

  it('free actions first (input order), then one turn action per player; a second one is refused', () => {
    const s = party(2);
    const r = turn(s, [act('p2', { type: 'wait' }, { type: 'toggle_sneak' }, { type: 'wait' }), act('p1', { type: 'toggle_sneak' })]);
    expect(r.outcomes.map((o) => [o.playerId, o.action.type, o.ok, o.reason])).toEqual([
      ['p2', 'wait', true, undefined],
      ['p2', 'toggle_sneak', true, undefined],
      ['p2', 'wait', false, 'illegal'],
      ['p1', 'toggle_sneak', true, undefined],
    ]);
    const sneakLines = r.state.log.filter((l) => l.key === 'log.sneak.on').map((l) => l.params?.player);
    expect(sneakLines).toEqual(['Bea', 'Ann']);
  });

  it('a target taken by an earlier mover is refused as contested', () => {
    // two players bump the same 1-hp rat: whoever resolves second finds it gone
    for (let seed = 1; seed < 40; seed++) {
      const s = party(2, { seed });
      const a1 = actorOf(s, 'p1');
      const a2 = actorOf(s, 'p2');
      const ratPos = { x: a1.pos.x + 1, y: a1.pos.y + 1 };
      if (Math.max(Math.abs(a2.pos.x - ratPos.x), Math.abs(a2.pos.y - ratPos.y)) !== 1) throw new Error('p2 not next to the rat');
      const rat = addActor(w, s, 'rat', ratPos, { hp: 1 });
      const r = turn(s, [act('p1', { type: 'attack', targetId: rat.id }), act('p2', { type: 'attack', targetId: rat.id })]);
      if (r.state.area.actors.some((a) => a.id === rat.id)) continue; // the first swing missed
      expect(r.outcomes[0].ok).toBe(true);
      expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'contested' });
      return;
    }
    throw new Error('no seed where the first swing killed the rat');
  });

  it('an input after a teammate took the exit is refused as area changed; the party moves on together', () => {
    const open = testWorld((x) => delete x.areas[0].transitionRequires);
    let s = party(2, { world: open });
    const exit = s.area.map.exit;
    actorOf(s, 'p1').pos = { ...exit };
    // p2 at the exit too, so the party moves on at once (no countdown, MP1 B3)
    actorOf(s, 'p2').pos = { x: exit.x - 1, y: exit.y };
    s = turn(s, [act('p1', { type: 'wait' })], false, open).state;
    // turn 1 resolves p2 first: let p1 lead by waiting one more round
    if (s.turn % 2 === 1) s = turn(s, [act('p1', { type: 'wait' })], false, open).state;
    const r = turn(s, [act('p1', { type: 'transition' }), act('p2', { type: 'move', dir: 'w' })], false, open);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'area changed' });
    expect(r.state.area.index).toBe(1);
    for (const id of r.state.party) {
      expect(r.state.area.actors.filter((a) => a.id === r.state.players[id].actorId)).toHaveLength(1);
      expect(r.state.players[id].seen.length).toBe(r.state.area.map.width * r.state.area.map.height);
    }
  });

  it('a hasted player acts twice per round; the other is not ready meanwhile', () => {
    let s = party(2);
    actorOf(s, 'p1').statuses.push({ id: 'haste', turnsLeft: 50 });
    s = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })]).state;
    // after the round p1 gained 200, p2 100: both act, then p1 alone
    s = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })]).state;
    expect(readyPlayers(s, env(w))).toEqual(['p1']);
    expect(legalActions(s, { ...env(w), playerId: 'p2' }).every((a) => a.type === 'talk' || a.type === 'toggle_sneak')).toBe(true);
    const before = s.turn;
    const r = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'not ready' });
    expect(r.state.turn).toBe(before + 1);
    expect(readyPlayers(r.state, env(w))).toEqual(['p1', 'p2']);
  });

  it('a stunned player burns their turn while the others play on', () => {
    let s = party(2);
    actorOf(s, 'p2').statuses.push({ id: 'stun', turnsLeft: 3 });
    expect(readyPlayers(s, env(w))).toEqual(['p1']);
    s = turn(s, [act('p1', { type: 'wait' })]).state;
    expect(s.log.some((l) => l.key === 'log.turn.stunned' && l.params?.player === 'Bea')).toBe(true);
  });

  it('busy is set by an input without a turn action and cleared by a turn action', () => {
    const s = party(2);
    const r = turn(s, [{ playerId: 'p2', busy: true }]);
    expect(r.state).not.toBe(s);
    expect(r.tookTurn).toBe(false);
    expect(r.state.players.p2.busySince).toBe(s.turn);
    const again = turn(r.state, [{ playerId: 'p2', busy: true }]);
    expect(again.state).toBe(r.state);
    const acted = turn(r.state, [{ playerId: 'p2', actions: [{ type: 'wait' }], busy: true }]);
    expect(acted.state.players.p2.busySince).toBeUndefined();
    const cleared = turn(r.state, [{ playerId: 'p2', busy: false }]);
    expect(cleared.state.players.p2.busySince).toBeUndefined();
  });
});

describe('teammates and per-player rules', () => {
  it('walking into a teammate swaps places (not when rooted)', () => {
    const s = party(2);
    const a1 = actorOf(s, 'p1').pos;
    const a2 = actorOf(s, 'p2').pos;
    const dir = (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).find((d) => {
      const dx = { n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1, nw: -1 }[d];
      const dy = { n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0, nw: -1 }[d];
      return a1.x + dx === a2.x && a1.y + dy === a2.y;
    })!;
    expect(legalActions(s, env(w))).toContainEqual({ type: 'move', dir });
    const r = turn(s, [act('p1', { type: 'move', dir })]);
    expect(actorOf(r.state, 'p1').pos).toEqual(a2);
    expect(actorOf(r.state, 'p2').pos).toEqual(a1);
    const rooted = structuredClone(s);
    actorOf(rooted, 'p1').statuses.push({ id: 'root', turnsLeft: 3 });
    expect(turn(rooted, [act('p1', { type: 'move', dir })]).outcomes[0].ok).toBe(false);
  });

  it("a hostile hitting p2 meets p2's own armour", () => {
    const s = party(2);
    const ps2 = s.players.p2;
    const slot = ps2.slots.findIndex((x) => x === null);
    ps2.slots[slot] = { id: `i${s.nextId++}`, defId: 'coat', count: 1 };
    ps2.equipped.armour = slot;
    const ctx = ctxOf(w, s);
    expect(getStat(ctx, actorOf(s, 'p2'), 'ac')).toBe(getStat(ctx, actorOf(s, 'p1'), 'ac') + 2);
  });

  it('each player regenerates and drains on their own; item cooldowns tick for everyone', () => {
    const drain = testWorld((x) => {
      x.resources![0].perTurn = -1;
    });
    let s = party(2, { world: drain });
    s.players.p2.resources.oil = 3;
    s = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })], false, drain).state;
    expect(s.players.p1.resources.oil).toBe(9);
    expect(s.players.p2.resources.oil).toBe(2);
  });

  it("p2's on_turn trigger reveals p2's fog and its xp is shared by the party", () => {
    const seer = testWorld((x) => {
      x.player.growth.perks.push({
        id: 'seer',
        name: 'Seer',
        description: 'sees',
        triggers: [{ on: 'on_turn', action: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false }, effects: [{ type: 'reveal_map', radius: 40 }, { type: 'grant_xp', amount: 1 }] } }],
      } as never);
    });
    // two rooms split by a wall without regions, so nobody remembers the far room on entry
    const map = roomMap(30, 10, { walls: Array.from({ length: 8 }, (_, i) => ({ x: 15, y: i + 1 })) });
    for (const t of map.tiles) delete t.region;
    map.regions = [];
    let s = party(2, { world: seer, map });
    s.players.p2.perks.push('seer');
    s = turn(s, [act('p1', { type: 'wait' }), act('p2', { type: 'wait' })], false, seer).state;
    const far = 5 * 30 + 25;
    expect(s.players.p2.seen[far]).toBeGreaterThan(0);
    expect(s.players.p1.seen[far]).toBe(0);
    expect(s.players.p1.xp).toBe(1);
    expect(s.players.p2.xp).toBe(1);
  });

  it('a kill gives its xp to every player', () => {
    const s = party(2);
    const a1 = actorOf(s, 'p1');
    const rat = addActor(w, s, 'rat', { x: a1.pos.x + 1, y: a1.pos.y + 1 }, { hp: 1 });
    for (let i = 0; i < 10; i++) {
      const r = turn(s, [act('p1', { type: 'attack', targetId: rat.id })]);
      if (r.state.area.actors.some((a) => a.id === rat.id)) {
        s.rng = r.state.rng;
        continue;
      }
      expect(r.state.players.p1.xp).toBe(4);
      expect(r.state.players.p2.xp).toBe(4);
      return;
    }
    throw new Error('the rat never died');
  });

  it('down and not-ready players: legalActions and refusals', () => {
    const s = party(2);
    actorOf(s, 'p2').energy = 0;
    const legal = legalActions(s, { ...env(w), playerId: 'p2' });
    expect(legal.some((a) => a.type === 'move' || a.type === 'wait')).toBe(false);
    expect(turn(s, [act('p2', { type: 'wait' })]).outcomes[0]).toMatchObject({ ok: false, reason: 'not ready' });
    expect(turn(s, [act('p2', { type: 'toggle_sneak' })]).outcomes[0].ok).toBe(true);
    const down = structuredClone(s);
    down.players.p2.down = { since: 0, helpedTurns: 0 };
    expect(legalActions(down, { ...env(w), playerId: 'p2' })).toEqual([]);
    expect(turn(down, [act('p2', { type: 'toggle_sneak' })]).outcomes[0]).toMatchObject({ ok: false, reason: 'down' });
    expect(ACT_COST).toBe(100);
  });
});
