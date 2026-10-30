/**
 * MP1 B4: party-aware bots. In a party a bot plans goals and locks the way the engine checks them
 * (the packs count together), walks over to a down teammate to get them up, brings a teammate the
 * items their goal item needs, and gathers at the exit while the countdown runs.
 */
import { describe, it, expect } from 'vitest';
import { env, roomMap, simpleGenerator, testWorld } from '../engine/helpers';
import { createGame, stepTurn } from '../../src/engine';
import { indexWorld, withPlayer, type Ctx } from '../../src/engine/ctx';
import { dealDamage } from '../../src/engine/combat';
import { giveItem, makeItem } from '../../src/engine/inventory';
import { rngFromState } from '../../src/engine/rng';
import { botByName, newMemory, type BotMemory } from '../../src/engine/sim/bots';
import { botCtx, currentObjectives } from '../../src/engine/sim/view';
import type { GameEvent, GameState, PlayerAction, PlayerId, Pos, TurnInput } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const explorer = botByName('explorer');

function party(world: WorldSpec, n: number, opts: { difficulty?: 'normal' | 'hard'; start?: Pos; exit?: Pos } = {}): GameState {
  const s = createGame(world, {
    seed: 7,
    difficulty: opts.difficulty ?? 'normal',
    map: roomMap(16, 12, { ...(opts.start ? { start: opts.start } : {}), ...(opts.exit ? { exit: opts.exit } : {}) }),
    mapGenerator: simpleGenerator,
    players: Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` })),
  });
  // players only: nothing else to fight or talk to
  const mine = new Set(s.party.map((id) => s.players[id].actorId));
  s.area.actors = s.area.actors.filter((a) => mine.has(a.id));
  s.area.items = [];
  return s;
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const ctxOf = (world: WorldSpec, s: GameState, pid: PlayerId): Ctx => ({ world, ix: indexWorld(world), s, pid, rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const give = (world: WorldSpec, s: GameState, pid: PlayerId, item: string) => {
  const c = ctxOf(world, s, pid);
  withPlayer(c, pid, () => giveItem(c, item));
};

/** plays party turns with one explorer bot per player until `done` or `max` turns */
function play(world: WorldSpec, s: GameState, max: number, done: (s: GameState, ev: GameEvent[]) => boolean) {
  const mems = new Map<PlayerId, BotMemory>(s.party.map((id, i) => [id, newMemory(i + 1)]));
  const actions: { pid: PlayerId; action: PlayerAction }[] = [];
  const events: GameEvent[] = [];
  for (let k = 0; k < max && s.status === 'playing'; k++) {
    const inputs: TurnInput[] = [];
    for (const pid of s.party) {
      if (s.players[pid].down) continue;
      const action = explorer.decide(s, world, mems.get(pid)!, pid);
      actions.push({ pid, action });
      inputs.push({ playerId: pid, actions: [action] });
    }
    const r = stepTurn(s, inputs, { ...env(world), advance: true });
    s = r.state;
    events.push(...r.events);
    if (done(s, r.events)) break;
  }
  return { s, actions, events };
}

describe('party-aware bots', () => {
  it('a lock item in a teammate’s pack is no objective for the others (solo: still personal)', () => {
    const w = testWorld();
    const s = party(w, 2);
    expect(currentObjectives(botCtx(w, s, 'p1')).lock).toEqual([{ kind: 'item', item: 'key', count: 1 }]);
    give(w, s, 'p2', 'key');
    expect(currentObjectives(botCtx(w, s, 'p1')).lock).toEqual([]);
    expect(currentObjectives(botCtx(w, s, 'p2')).lock).toEqual([]);
    const solo = party(w, 1);
    expect(currentObjectives(botCtx(w, solo, 'p1')).lock).toEqual([{ kind: 'item', item: 'key', count: 1 }]);
  });

  it('walks over to a down teammate and gets them up', () => {
    const w = testWorld();
    const s = party(w, 2, { difficulty: 'hard' });
    actorOf(s, 'p1').pos = { x: 2, y: 2 };
    actorOf(s, 'p2').pos = { x: 9, y: 8 };
    dealDamage(ctxOf(w, s, 'p1'), actorOf(s, 'p2'), 999, 'physical');
    expect(s.players.p2.down).toBeTruthy();
    const r = play(w, s, 15, (_, ev) => ev.some((e) => e.type === 'revived'));
    const up = r.events.find((e) => e.type === 'revived');
    expect(up).toMatchObject({ type: 'revived', playerId: 'p2', helped: true });
    expect(r.s.players.p2.down).toBeFalsy();
  });

  it('brings a teammate the item their goal item needs, and the teammate uses it', () => {
    // the horn wins the run (sets the goal flag), but only in the hands of whoever also holds the key
    const w = testWorld((input) => {
      input.items.push({
        id: 'horn',
        name: 'Horn',
        kind: 'Horn',
        description: 'blow it while holding the key',
        category: 'quest',
        useMode: 'reusable',
        onUse: {
          targeting: { shape: 'self', affects: 'self_only', range: 0 },
          condition: { type: 'has_item', who: 'player', item: 'key' },
          effects: [{ type: 'set_flag', flag: 'boss-down' }],
        },
        model: { archetype: 'prop', parts: [{ shape: 'box', size: [0.3, 0.3, 0.3], pos: [0, 0.15, 0], color: '#aa7700' }] },
      } as never);
    });
    const s = party(w, 2);
    actorOf(s, 'p1').pos = { x: 3, y: 3 };
    actorOf(s, 'p2').pos = { x: 11, y: 8 };
    give(w, s, 'p1', 'horn');
    give(w, s, 'p2', 'key');
    const r = play(w, s, 40, (st) => st.status !== 'playing');
    expect(r.actions.some((a) => a.pid === 'p2' && a.action.type === 'drop')).toBe(true);
    expect(r.s.status).toBe('won');
  });

  it('gathers at the exit while the countdown runs, so the party moves on early', () => {
    const w = testWorld();
    const exit = { x: 14, y: 10 };
    const s = party(w, 2, { exit });
    give(w, s, 'p1', 'key');
    actorOf(s, 'p1').pos = { ...exit };
    actorOf(s, 'p2').pos = { x: 10, y: 6 };
    // left alone, p2 would go for the tonic in the far corner first
    const c = ctxOf(w, s, 'p2');
    s.area.items.push({ item: makeItem(c, 'tonic')!, pos: { x: 2, y: 2 } });
    const started = stepTurn(s, [{ playerId: 'p1', actions: [{ type: 'transition' }] }, { playerId: 'p2', actions: [{ type: 'wait' }] }], { ...env(w), advance: true }).state;
    const left = started.area.exitCountdown!.turnsLeft;
    const r = play(w, started, left, (st) => st.area.index === 1);
    expect(r.s.area.index).toBe(1);
    // p2 walked over (3 steps) instead of being pulled along when the countdown ran out
    expect(r.actions.filter((a) => a.pid === 'p2').length).toBeLessThan(left);
    expect(r.actions.filter((a) => a.pid === 'p2').every((a) => a.action.type === 'move')).toBe(true);
  });
});
