/**
 * MP1 B2b: run-level conditions for a party (conditions.ts evalParty), walked once and quantified
 * per leaf: has_item counts every pack (down players' too), stat / status / terrain need any
 * standing player to win and every standing player to lose, `not` negates the quantified leaf,
 * `chance` draws once. Used by goal.win / goal.lose, transition locks and quests (rewards go to
 * the player who met the condition).
 */
import { describe, it, expect } from 'vitest';
import { env, roomMap, simpleGenerator, testWorld } from './helpers';
import { createGame, stepTurn } from '../../src/engine';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { evalParty, evalPartyFull } from '../../src/engine/conditions';
import { transitionFailure } from '../../src/engine/area';
import { downPlayer } from '../../src/engine/combat';
import { countItem } from '../../src/engine/inventory';
import { rngFromState } from '../../src/engine/rng';
import type { Condition } from '../../src/schema/world';
import type { GameState, PlayerId } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const w = testWorld();

function party(n: number, world: WorldSpec = w): GameState {
  return createGame(world, { seed: 6, map: roomMap(14, 10), mapGenerator: simpleGenerator, players: Array.from({ length: n }, (_, i) => ({ name: ['Ann', 'Bea', 'Cid'][i] })) });
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const ctxOf = (s: GameState, pid: PlayerId = s.party[0], world: WorldSpec = w): Ctx => ({ world, ix: indexWorld(world), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const give = (s: GameState, pid: PlayerId, defId: string) => {
  const slots = s.players[pid].slots;
  slots[slots.findIndex((x) => !x)] = { id: `i${s.nextId++}`, defId, count: 1 };
};

const hasKey: Condition = { type: 'has_item', who: 'player', item: 'key' };
const hasRing: Condition = { type: 'has_item', who: 'player', item: 'ring' };
const burning: Condition = { type: 'has_status', who: 'player', status: 'burning' };
const low: Condition = { type: 'stat', who: 'player', stat: 'hp', cmp: 'lt', value: 50, asPercentOfMax: true };

describe('evalParty per leaf', () => {
  it('all(has_item A, has_item B) holds with A and B in different packs', () => {
    const s = party(2);
    give(s, 'p1', 'key');
    const c = ctxOf(s);
    expect(evalParty(c, { type: 'all', of: [hasKey, hasRing] }, 'win')).toBe(false);
    give(s, 'p2', 'ring');
    expect(evalParty(c, { type: 'all', of: [hasKey, hasRing] }, 'win')).toBe(true);
    // the count adds the packs up
    give(s, 'p2', 'key');
    expect(evalParty(c, { type: 'has_item', who: 'self', item: 'key', count: 2 }, 'win')).toBe(true);
  });

  it('not() negates the quantified leaf', () => {
    const s = party(2);
    const c = ctxOf(s);
    const notBurning: Condition = { type: 'not', cond: burning };
    expect(evalParty(c, notBurning, 'win')).toBe(true);
    actorOf(s, 'p2').statuses.push({ id: 'burning', turnsLeft: 3 });
    expect(evalParty(c, notBurning, 'win')).toBe(false);
  });

  it('a chance leaf draws from the rng once', () => {
    const s = party(3);
    const c = ctxOf(s);
    const before = rngFromState(c.rng.state());
    evalParty(c, { type: 'all', of: [{ type: 'chance', p: 0.5 }, hasKey] }, 'win');
    before.chance(0.5);
    expect(c.rng.state()).toEqual(before.state());
  });

  it('lose needs every standing player; win needs one', () => {
    const s = party(2);
    const c = ctxOf(s);
    actorOf(s, 'p1').hp = 3;
    expect(evalParty(c, low, 'win')).toBe(true);
    expect(evalParty(c, low, 'lose')).toBe(false);
    actorOf(s, 'p2').hp = 3;
    expect(evalParty(c, low, 'lose')).toBe(true);
    // a down player is not standing: the others decide
    downPlayer(c, s.players.p2, actorOf(s, 'p2'));
    actorOf(s, 'p1').hp = actorOf(s, 'p1').maxHp;
    expect(evalParty(c, low, 'lose')).toBe(false);
  });

  it('the deciding player is the first whose personal leaf held', () => {
    const s = party(3);
    give(s, 'p3', 'ring');
    expect(evalPartyFull(ctxOf(s), hasRing, 'win')).toEqual({ ok: true, decider: 'p3' });
    expect(evalPartyFull(ctxOf(s), { type: 'flag', flag: 'x', value: false }, 'win')).toEqual({ ok: true });
  });
});

describe('goals, locks and quests for the party', () => {
  it('the goal is won with the parts in two packs', () => {
    const world = testWorld((wi) => {
      wi.goal.win = { type: 'all', of: [hasKey, hasRing] };
      wi.areas[1].placedItems = [...(wi.areas[1].placedItems ?? []), { item: 'ring', where: 'far' }];
    });
    const s = party(2, world);
    give(s, 'p1', 'key');
    give(s, 'p2', 'ring');
    const r = stepTurn(s, [{ playerId: 'p1', actions: [{ type: 'wait' }] }], env(world));
    expect(r.state.status).toBe('won');
  });

  it('a down key-holder still opens the way on', () => {
    const s = party(2);
    actorOf(s, 'p1').pos = { ...s.area.map.exit };
    const c = ctxOf(s);
    expect(transitionFailure(c)).toMatch(/locked/);
    give(s, 'p2', 'key');
    downPlayer(c, s.players.p2, actorOf(s, 'p2'));
    expect(transitionFailure(c)).toBeNull();
  });

  it('a quest reward item goes to the player who met the condition', () => {
    const s = party(2);
    give(s, 'p2', 'ring');
    s.quests.push({ id: 'q1', title: 'Find the ring', description: 'd', complete: hasRing, reward: [{ type: 'give_item', item: 'coat', count: 1 }], status: 'active' });
    const r = stepTurn(s, [{ playerId: 'p1', actions: [{ type: 'wait' }] }], env(w));
    expect(r.state.quests[0].status).toBe('done');
    expect(countItem(r.state.players.p2, 'coat')).toBe(1);
    expect(countItem(r.state.players.p1, 'coat')).toBe(0);
  });
});
