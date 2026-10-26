/**
 * Regression tests for review M5 round 2 (issues/M5-gm-effect-unbounded-damage.md,
 * M5-gm-fiat-other-conditions.md, M5-gm-trade-free-items.md): the GM (and NPC dialogue, which
 * shares the checks) could still win, lose or soft-lock the run by fiat through actor_defeated,
 * player hp and stat conditions, carry unbounded damage, and hand out any item through `trade`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { GmAction } from '../../src/schema/gm';
import type { GameState } from '../../src/engine/types';
import { applyGmActions, createGame, step, leadPlayer } from '../../src/engine/index';
import {
  gmActionProblems,
  isHelpfulAction,
  applyHelpCeiling,
  amountMax,
  boundProblem,
  tradeFloor,
  GM_AMOUNT_LIMIT,
  keepValidActions,
  stateGoalProblem,
  goalWriteProblem,
} from '../../src/llm/gm-checks';
import { goalRefs, protectedGoalLine } from '../../src/llm/goal-refs';
import { playToSituation } from '../../src/llm/situation';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { WORLD_DIR, addActor } from '../engine/helpers';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(WORLD_DIR, `${name}.json`), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

/** play on until an actor of `defId` is visible to the player (seen === 2) */
function bossInSight(world: WorldSpec, area: number, defId: string): GameState | null {
  for (let seed = 1; seed <= 30; seed++) {
    const sit = playToSituation(world, { seed, area });
    if (!sit.reached) continue;
    let s = sit.state;
    const bot = botByName('explorer');
    const mem = newMemory(seed);
    for (let i = 0; i < 1500 && s.status === 'playing' && s.area.index === area; i++) {
      const boss = s.area.actors.find((a) => a.defId === defId && a.hp > 0);
      if (boss && leadPlayer(s).seen[boss.pos.y * s.area.map.width + boss.pos.x] === 2) return s;
      s = step(s, bot.decide(s, world, mem), { world }).state;
    }
  }
  return null;
}

const teen = fixture('fixture-teen');

describe('goal refs cover actor_defeated and stat conditions', () => {
  it('collects the goal actors and stats, and the prompt line names them', () => {
    expect(goalRefs(teen).actors.has('mags-calloway')).toBe(true);
    const tri = fixture('abstract-yellow-triangle');
    expect(goalRefs(tri).stats.has('varnish')).toBe(true);
    expect(protectedGoalLine(teen)).toContain('"mags-calloway"');
    expect(protectedGoalLine(tri)).toContain('"varnish"');
    expect(protectedGoalLine(teen)).toMatch(/lethal/);
  });
});

describe('GM fiat through actor_defeated', () => {
  const state = bossInSight(teen, 2, 'mags-calloway');

  it('finds a snapshot with the final boss in sight', () => {
    expect(state).not.toBeNull();
  });

  it('refuses huge damage at the boss (bound + goal actor in the area)', () => {
    const kill = GmAction.parse({ type: 'effect', target: 'all_visible_enemies', effects: [{ type: 'damage', amount: { base: 100000 } }] });
    const problems = gmActionProblems(teen, state!, [kill]);
    expect(problems.length).toBe(1);
    expect(keepValidActions(teen, state!, [kill])).toEqual([]);
  });

  it('refuses even small harmful effects at enemies while the goal actor is in the area', () => {
    const poke = GmAction.parse({ type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 3 } }] });
    const problems = gmActionProblems(teen, state!, [poke]);
    expect(problems[0]?.message).toMatch(/mags-calloway/);
  });

  it('refuses transforming the boss (actor_defeated could never be met)', () => {
    const other = teen.actors.find((a) => a.id !== 'mags-calloway' && !a.npc)!.id;
    const tf = GmAction.parse({ type: 'effect', target: 'all_visible_enemies', effects: [{ type: 'transform', into: other }] });
    expect(gmActionProblems(teen, state!, [tf]).length).toBe(1);
  });

  it('refuses change_faction on the boss, by def id or instance id', () => {
    const boss = state!.area.actors.find((a) => a.defId === 'mags-calloway')!;
    for (const actorId of ['mags-calloway', boss.id]) {
      const turn = GmAction.parse({ type: 'change_faction', actorId, faction: 'friendly' });
      expect(gmActionProblems(teen, state!, [turn]).length).toBe(1);
    }
  });

  it('still allows harmful effects at enemies in an area without a goal actor', () => {
    const sit = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 5 });
    expect(sit.state.area.actors.some((a) => goalRefs(teen).actors.has(a.defId) && a.hp > 0)).toBe(false);
    const poke = GmAction.parse({ type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 5 } }] });
    expect(stateGoalProblem(teen, sit.state, poke)).toBeNull();
    expect(goalWriteProblem(teen, poke)).toBeNull();
    expect(boundProblem(teen, poke)).toBeNull();
  });

  it('corporate-merger-kitchen: one GM action with damage 1e6 cannot win the run', () => {
    const world = fixture('corporate-merger-kitchen');
    let s = createGame(world, { seed: 1 });
    const p = s.area.actors.find((a) => a.id === leadPlayer(s).actorId)!;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    const free = dirs.map(([dx, dy]) => ({ x: p.pos.x + dx!, y: p.pos.y + dy! })).find((q) => {
      const t = s.area.map.tiles[q.y * s.area.map.width + q.x];
      return t && t.kind !== 'wall' && !s.area.actors.some((a) => a.pos.x === q.x && a.pos.y === q.y);
    })!;
    addActor(world, s, 'odile-greaves', free, { ai: { alerted: true, home: free } } as never);
    s = step(s, { type: 'wait' }, { world }).state;
    const a = GmAction.parse({ type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 1_000_000 } }] });
    expect(gmActionProblems(world, s, [a]).length).toBe(1);
    // and a 50-damage effect (within the bound) is still refused: the boss is the player's to defeat
    const b = GmAction.parse({ type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 50 } }] });
    expect(gmActionProblems(world, s, [b]).length).toBe(1);
    expect(applyGmActions(s, keepValidActions(world, s, [a, b]), { world }).state.status).toBe('playing');
  });
});

describe('GM fiat on the player and stat lose conditions', () => {
  it('refuses damage that could knock the player out, allows a scratch', () => {
    const sit = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 5 });
    const pl = sit.state.area.actors.find((a) => a.id === leadPlayer(sit.state).actorId)!;
    const lethal = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: pl.hp } }] });
    expect(gmActionProblems(teen, sit.state, [lethal])[0]?.message).toMatch(/knock the player out/);
    const huge = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 100000 } }] });
    expect(gmActionProblems(teen, sit.state, [huge]).length).toBe(1);
    if (pl.hp > 2) {
      const scratch = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 1 } }] });
      expect(gmActionProblems(teen, sit.state, [scratch])).toEqual([]);
    }
  });

  it('abstract-yellow-triangle: refuses resource / modify_stat on the lose stat (varnish)', () => {
    const tri = fixture('abstract-yellow-triangle');
    const sit = playToSituation(tri, { seed: 1, area: 0, turnsInArea: 5 });
    expect(sit.state.status).toBe('playing');
    const push = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'resource', resource: 'varnish', amount: { base: 40 } }] });
    expect(gmActionProblems(tri, sit.state, [push])[0]?.message).toMatch(/varnish/);
    const mod = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'modify_stat', stat: 'varnish', amount: 5 }] });
    expect(gmActionProblems(tri, sit.state, [mod]).length).toBe(1);
    expect(applyGmActions(sit.state, keepValidActions(tri, sit.state, [push, mod]), { world: tri }).state.status).toBe('playing');
  });
});

describe('GM effect amounts are bounded', () => {
  it('amountMax adds base, dice maximum and scale', () => {
    expect(amountMax({ base: 3, dice: '2d6' })).toBe(15);
    expect(amountMax({ base: -10 })).toBe(10);
    expect(amountMax({ base: 0, scale: { stat: 'str', factor: 1 } })).toBe(20);
  });

  it('refuses amounts past GM_AMOUNT_LIMIT, also inside offer options', () => {
    const big = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'heal', amount: { base: 0, dice: '20d20' } }] });
    expect(boundProblem(teen, big)).toMatch(String(GM_AMOUNT_LIMIT));
    const ok = GmAction.parse({ type: 'effect', target: 'player', effects: [{ type: 'heal', amount: { base: 2, dice: '2d6' } }] });
    expect(boundProblem(teen, ok)).toBeNull();
    const offer = GmAction.parse({ type: 'offer_choice', prompt: '?', options: [{ label: 'a', actions: [big] }, { label: 'b', actions: [] }] });
    expect(boundProblem(teen, offer)).not.toBeNull();
  });
});

describe('GM trade', () => {
  const sit = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 10 });
  const s0 = sit.state;
  const other = s0.area.actors.find((a) => a.id !== leadPlayer(s0).actorId && a.hp > 0 && a.faction !== 'hostile') ?? s0.area.actors.find((a) => a.id !== leadPlayer(s0).actorId && a.hp > 0)!;

  it('refuses a trade of the lock item at any price', () => {
    expect(goalRefs(teen).items.has('speech-notebook')).toBe(true);
    for (const price of [0, 9999]) {
      const trade = GmAction.parse({ type: 'trade', actorId: other.id, items: [{ item: 'speech-notebook', price }] });
      expect(gmActionProblems(teen, s0, [trade])[0]?.message).toMatch(/speech-notebook/);
    }
  });

  it('refuses prices below half the value and counts bargains as help', () => {
    const item = teen.items.find((i) => !goalRefs(teen).items.has(i.id) && i.value >= 4)!;
    const floor = tradeFloor(teen, item.id);
    expect(floor).toBe(Math.ceil(item.value / 2));
    const free = GmAction.parse({ type: 'trade', actorId: other.id, items: [{ item: item.id, price: 0 }] });
    expect(boundProblem(teen, free)).toMatch(/half its value/);
    const bargain = GmAction.parse({ type: 'trade', actorId: other.id, items: [{ item: item.id, price: floor }] });
    expect(boundProblem(teen, bargain)).toBeNull();
    expect(isHelpfulAction(teen, bargain, s0)).toBe(true);
    expect(applyHelpCeiling(teen, [bargain], 0, s0).actions).toEqual([]);
    const fair = GmAction.parse({ type: 'trade', actorId: other.id, items: [{ item: item.id, price: item.value }] });
    expect(isHelpfulAction(teen, fair, s0)).toBe(false);
  });

  it('refuses a trade from a hostile actor', () => {
    const hostile = s0.area.actors.find((a) => a.id !== leadPlayer(s0).actorId && a.hp > 0 && a.faction === 'hostile');
    if (!hostile) return;
    const item = teen.items.find((i) => !goalRefs(teen).items.has(i.id))!;
    const trade = GmAction.parse({ type: 'trade', actorId: hostile.id, items: [{ item: item.id, price: item.value }] });
    expect(gmActionProblems(teen, s0, [trade])[0]?.message).toMatch(/hostile/);
  });
});
