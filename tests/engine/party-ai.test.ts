/**
 * MP1 B2b: hostiles among players. The nearest player is the target, a current target is kept
 * while it is at most TARGET_STICK_TILES farther; busy players are not attacked (approached to
 * BUSY_WAIT_RANGE) for BUSY_MAX_TURNS; a turn action ends busy; splash still hits a busy neighbour;
 * perception (sight of the tile, sneaking) is per player; "player" in a hostile's conditions is
 * its target; allies guard their down owner.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import { createGame, stepTurn } from '../../src/engine';
import { BUSY_MAX_TURNS, BUSY_WAIT_RANGE, isBusy, noticeRadius } from '../../src/engine/ai';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { playerSeesTile } from '../../src/engine/vision';
import { downPlayer } from '../../src/engine/combat';
import { rngFromState } from '../../src/engine/rng';
import { cheb } from '../../src/engine/util';
import type { ActorInstance, AreaMap, GameState, GameEvent, PlayerAction, PlayerId, Pos, TurnInput } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const w = testWorld();

function party(n: number, opts: { world?: WorldSpec; map?: AreaMap } = {}): GameState {
  return createGame(opts.world ?? w, {
    seed: 3,
    map: opts.map ?? roomMap(14, 12),
    mapGenerator: simpleGenerator,
    players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid'][i] })),
  });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const byId = (s: GameState, id: string) => s.area.actors.find((a) => a.id === id)!;
const ctxOf = (world: WorldSpec, s: GameState, pid: PlayerId = s.party[0]): Ctx => ({ world, ix: indexWorld(world), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const act = (pid: PlayerId, ...actions: PlayerAction[]): TurnInput => ({ playerId: pid, actions });
const waitAll = (s: GameState, except: PlayerId[] = []) => s.party.filter((id) => !except.includes(id)).map((id) => act(id, { type: 'wait' }));
const turn = (s: GameState, inputs: TurnInput[], world: WorldSpec = w) => stepTurn(s, inputs, { ...env(world), advance: true });

/** players placed by hand (test setup only) */
function place(s: GameState, at: Record<PlayerId, Pos>): void {
  for (const [pid, p] of Object.entries(at)) actorOf(s, pid).pos = { ...p };
}

const attacksOn = (events: GameEvent[], actorId: string) => events.filter((e) => e.type === 'attacked' && e.targetId === actorId);

describe('target choice among players', () => {
  it('goes for the nearest player and remembers it', () => {
    const s = party(2);
    place(s, { p1: { x: 2, y: 2 }, p2: { x: 10, y: 2 } });
    const rat = addActor(w, s, 'rat', { x: 8, y: 2 });
    const r = turn(s, waitAll(s));
    const rat2 = byId(r.state, rat.id);
    expect(rat2.ai.targetId).toBe(actorOf(r.state, 'p2').id);
    expect(rat2.pos.x).toBe(9);
  });

  it('keeps its target while it is at most 2 tiles farther than the nearest, then switches', () => {
    const s = party(2);
    place(s, { p1: { x: 6, y: 3 }, p2: { x: 6, y: 9 } });
    const rat = addActor(w, s, 'rat', { x: 6, y: 5 }, { ai: { alerted: true, targetId: '' } });
    rat.ai.targetId = actorOf(s, 'p2').id;
    // p1 at 2, p2 at 4: kept
    let r = turn(s, waitAll(s));
    expect(byId(r.state, rat.id).ai.targetId).toBe(actorOf(s, 'p2').id);
    expect(byId(r.state, rat.id).pos.y).toBe(6);
    // p1 at 1, p2 at 5 (more than 2 farther): the nearest wins
    const s2 = party(2);
    place(s2, { p1: { x: 6, y: 4 }, p2: { x: 6, y: 10 } });
    const rat2 = addActor(w, s2, 'rat', { x: 6, y: 5 }, { ai: { alerted: true } });
    rat2.ai.targetId = actorOf(s2, 'p2').id;
    r = turn(s2, waitAll(s2));
    expect(byId(r.state, rat2.id).ai.targetId).toBe(actorOf(s2, 'p1').id);
    expect(attacksOn(r.events, actorOf(s2, 'p1').id).length).toBe(1);
  });

  it('a party of one stores no target (single-player state unchanged)', () => {
    const s = party(1);
    const rat = addActor(w, s, 'rat', { x: 4, y: 1 });
    const r = turn(s, waitAll(s));
    expect(byId(r.state, rat.id).ai.targetId).toBeUndefined();
  });
});

describe('busy players', () => {
  it('a busy player is approached to 2 tiles but not attacked, until busy runs out', () => {
    // a wall keeps p2 out of the rat's sight: only p1 is perceived
    const s = party(2, { map: roomMap(20, 12, { walls: Array.from({ length: 10 }, (_, i) => ({ x: 12, y: i + 1 })) }) });
    place(s, { p1: { x: 2, y: 5 }, p2: { x: 16, y: 5 } });
    const rat = addActor(w, s, 'rat', { x: 7, y: 5 }, { ai: { alerted: true } });
    let st = s;
    const busyIn: TurnInput[] = [{ playerId: 'p1', busy: true }, act('p2', { type: 'wait' })];
    st = turn(st, busyIn).state;
    expect(st.players.p1.busySince).toBe(s.turn);
    let hits = 0;
    for (let i = 0; i < BUSY_MAX_TURNS - 2; i++) {
      const r = turn(st, [act('p2', { type: 'wait' })]);
      hits += attacksOn(r.events, actorOf(st, 'p1').id).length;
      st = r.state;
    }
    expect(hits).toBe(0);
    expect(cheb(byId(st, rat.id).pos, actorOf(st, 'p1').pos)).toBe(BUSY_WAIT_RANGE);
    expect(byId(st, rat.id).ai.targetId).toBeUndefined();
    // busy for BUSY_MAX_TURNS: the flag is ignored and the rat attacks
    for (let i = 0; i < 4 && !hits; i++) {
      const r = turn(st, [act('p2', { type: 'wait' })]);
      hits += attacksOn(r.events, actorOf(st, 'p1').id).length;
      st = r.state;
    }
    expect(st.turn - st.players.p1.busySince!).toBeGreaterThanOrEqual(BUSY_MAX_TURNS);
    expect(hits).toBeGreaterThan(0);
  });

  it('an open dialogue makes a player busy; a turn action ends busy', () => {
    const s = party(2);
    place(s, { p1: { x: 3, y: 3 }, p2: { x: 10, y: 8 } });
    const sage = addActor(w, s, 'sage', { x: 4, y: 3 });
    let r = stepTurn(s, [act('p1', { type: 'talk', targetId: sage.id })], env(w));
    expect(r.state.players.p1.pendingChoice).not.toBeNull();
    expect(r.state.players.p1.busySince).toBe(s.turn);
    const c = ctxOf(w, r.state);
    expect(isBusy(c, r.state.players.p1)).toBe(true);
    expect(isBusy(c, r.state.players.p2)).toBe(false);
    // the last option ends the talk; busy goes with it
    const n = r.state.players.p1.pendingChoice!.options.length;
    r = stepTurn(r.state, [act('p1', { type: 'choose_option', index: n - 1 })], env(w));
    if (!r.state.players.p1.pendingChoice) expect(r.state.players.p1.busySince).toBeUndefined();
    // busy from typing, then a move clears it
    r = turn(r.state, [{ playerId: 'p2', busy: true }]);
    expect(r.state.players.p2.busySince).toBeDefined();
    r = turn(r.state, [act('p2', { type: 'move', dir: 'w' })]);
    expect(r.state.players.p2.busySince).toBeUndefined();
  });

  it('busy:false while a dialogue stays open does not lift the BUSY_MAX_TURNS cap', () => {
    const s = party(2, { map: roomMap(20, 12, { walls: Array.from({ length: 10 }, (_, i) => ({ x: 12, y: i + 1 })) }) });
    place(s, { p1: { x: 3, y: 5 }, p2: { x: 16, y: 5 } });
    const sage = addActor(w, s, 'sage', { x: 3, y: 4 });
    const rat = addActor(w, s, 'rat', { x: 5, y: 5 }, { ai: { alerted: true } });
    rat.hp = rat.maxHp = 99999;
    let st = stepTurn(s, [act('p1', { type: 'talk', targetId: sage.id })], env(w)).state;
    expect(st.players.p1.pendingChoice).not.toBeNull();
    let hits = 0;
    for (let i = 0; i < BUSY_MAX_TURNS + 10; i++) {
      const r = turn(st, [{ playerId: 'p1', busy: false }, act('p2', { type: 'wait' })]);
      hits += attacksOn(r.events, actorOf(st, 'p1').id).length;
      st = r.state;
    }
    expect(st.players.p1.pendingChoice).not.toBeNull();
    expect(st.players.p1.busySince).toBe(s.turn);
    expect(hits).toBeGreaterThan(0);
  });

  it('a busy player is skipped for a target who is not busy, but splash still reaches them', () => {
    const world = testWorld((wi) => {
      const archer = wi.actors.find((a) => a.id === 'archer')!;
      archer.abilities = [
        {
          id: 'blast',
          name: 'Blast',
          description: 'boom',
          useWhen: 'target_in_range',
          action: { targeting: { shape: 'area', range: 6, radius: 1, affects: 'enemies' }, effects: [{ type: 'damage', amount: { base: 2 }, damageType: 'fire' }] },
          cooldown: 1,
        },
      ];
    });
    let splashed = false;
    for (let seed = 1; seed <= 12 && !splashed; seed++) {
      const s = createGame(world, { seed, map: roomMap(14, 12), mapGenerator: simpleGenerator, players: [{ name: 'Ann' }, { name: 'Bea' }] });
      place(s, { p1: { x: 6, y: 5 }, p2: { x: 7, y: 5 } });
      const archer = addActor(world, s, 'archer', { x: 6, y: 8 }, { ai: { alerted: true } });
      s.players.p1.busySince = s.turn;
      const r = turn(s, [{ playerId: 'p1' }, act('p2', { type: 'wait' })], world);
      // the chosen target is p2 (never the busy p1)
      expect(byId(r.state, archer.id).ai.targetId).toBe(actorOf(s, 'p2').id);
      if (r.events.some((e) => e.type === 'damaged' && e.actorId === actorOf(s, 'p1').id && e.damageType === 'fire')) splashed = true;
    }
    expect(splashed).toBe(true);
  });
});

describe('perception per player', () => {
  it('playerSeesTile answers for the player asked', () => {
    const map = roomMap(14, 12, { walls: [5, 6, 7, 8, 9, 10].map((y) => ({ x: 7, y })) });
    const s = party(2, { map });
    place(s, { p1: { x: 3, y: 8 }, p2: { x: 11, y: 8 } });
    const c = ctxOf(w, s);
    expect(playerSeesTile(c, 'p1', { x: 4, y: 8 })).toBe(true);
    expect(playerSeesTile(c, 'p2', { x: 4, y: 8 })).toBe(false);
    expect(playerSeesTile(c, 'p2', { x: 10, y: 8 })).toBe(true);
  });

  it('a hostile never shoots a player from a tile that player cannot see', () => {
    // p2 is blinded (sight 1): the archer has a clear shot but stands where p2 cannot see; p1 sees it
    const s = party(2);
    place(s, { p1: { x: 6, y: 9 }, p2: { x: 10, y: 4 } });
    actorOf(s, 'p2').statuses.push({ id: 'blind', turnsLeft: 50 });
    const archer = addActor(w, s, 'archer', { x: 6, y: 4 }, { ai: { alerted: true }, mp: 0 });
    archer.ai.targetId = actorOf(s, 'p2').id;
    const c = ctxOf(w, s);
    expect(playerSeesTile(c, 'p2', archer.pos)).toBe(false);
    expect(playerSeesTile(c, 'p1', archer.pos)).toBe(true);
    const r = turn(s, waitAll(s));
    const shots = r.events.filter((e) => e.type === 'attacked' && e.targetId === actorOf(s, 'p2').id && e.ranged && cheb(byId(r.state, archer.id).pos, actorOf(r.state, 'p2').pos) > 1);
    expect(shots.length).toBe(0);
  });

  it('sneaking halves notice for that player only', () => {
    const s = party(2);
    s.players.p1.sneaking = true;
    const rat = addActor(w, s, 'rat', { x: 6, y: 6 });
    const c = ctxOf(w, s);
    const full = noticeRadius(c, rat, actorOf(s, 'p2'));
    expect(noticeRadius(c, rat, actorOf(s, 'p1'))).toBe(Math.max(1, Math.ceil(full / 2)));
  });

  it('"player" in a hostile ability condition is its target', () => {
    const world = testWorld((wi) => {
      const archer = wi.actors.find((a) => a.id === 'archer')!;
      archer.abilities = [
        {
          id: 'mark',
          name: 'Mark',
          description: 'marks the key-bearer',
          useWhen: 'always',
          action: {
            targeting: { shape: 'self', affects: 'self_only' },
            condition: { type: 'has_item', who: 'player', item: 'key' },
            effects: [{ type: 'set_flag', flag: 'marked' }],
          },
          cooldown: 0,
        },
      ];
    });
    const run = (holder: PlayerId) => {
      for (let seed = 1; seed <= 10; seed++) {
        const s = createGame(world, { seed, map: roomMap(14, 12), mapGenerator: simpleGenerator, players: [{ name: 'Ann' }, { name: 'Bea' }] });
        place(s, { p1: { x: 2, y: 2 }, p2: { x: 11, y: 9 } });
        const slot = s.players[holder].slots.findIndex((x) => !x);
        s.players[holder].slots[slot] = { id: `i${s.nextId++}`, defId: 'key', count: 1 };
        // the archer is next to p2: p2 is its target
        addActor(world, s, 'archer', { x: 10, y: 9 }, { ai: { alerted: true } });
        let st = s;
        for (let i = 0; i < 6; i++) st = turn(st, waitAll(st), world).state;
        if (st.flags.marked) return true;
      }
      return false;
    };
    expect(run('p2')).toBe(true);
    expect(run('p1')).toBe(false);
  });
});

describe('allies of a down player', () => {
  it('guard the body: stay near it and leave far hostiles alone', () => {
    const s = party(2, { map: roomMap(20, 12) });
    place(s, { p1: { x: 17, y: 10 }, p2: { x: 3, y: 5 } });
    const c = ctxOf(w, s);
    downPlayer(c, s.players.p2, actorOf(s, 'p2'));
    const ally: ActorInstance = addActor(w, s, 'rat', { x: 8, y: 5 }, { faction: 'player', allyOf: actorOf(s, 'p2').id });
    addActor(w, s, 'golem', { x: 12, y: 5 });
    let st = s;
    for (let i = 0; i < 6; i++) st = turn(st, [act('p1', { type: 'wait' })]).state;
    const a = byId(st, ally.id);
    expect(cheb(a.pos, actorOf(st, 'p2').pos)).toBeLessThanOrEqual(2);
  });
});
