/**
 * MP1 B3: an area grows with the party it is built for (PARTY_SCALING, factor 1 + k·(n − 1)): map
 * size, hostile numbers and hp (more for bosses), items, the GM budget and the actor cap. A party
 * of one skips all of it, so single-player games are unchanged (the golden replay test checks the
 * same from the other side).
 */
import { describe, it, expect } from 'vitest';
import { testWorld } from './helpers';
import { MAX_AREA_ACTORS, PARTY_SCALING, addPlayer, applyGmActions, createGame, partyFactor } from '../../src/engine';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { areaActorCap, spawnActor, transformActor } from '../../src/engine/actors';
import { killActor } from '../../src/engine/combat';
import { mapDimensions } from '../../src/engine/mapgen';
import { rngFromState } from '../../src/engine/rng';
import { generateArea } from '../../src/engine/mapgen';
import { invariantError } from '../../src/engine/sim/run';
import type { Difficulty } from '../../src/schema/gm';
import type { GameState } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

/** area 0: a real generator, a spawn table of rats (2–3) and four tonics on the floor */
const w = testWorld((x) => {
  x.areas[0].actors = [{ actor: 'rat', weight: 10, min: 2, max: 3 }];
  x.areas[0].items = [{ item: 'tonic', weight: 10 }];
  x.areas[0].itemCount = 4;
  x.actors.push({ ...x.actors.find((a) => a.id === 'boss')!, id: 'boss2', name: 'Boss Unbound', stats: { hp: 30, ac: 10 }, triggers: [] });
});

function game(n: number, difficulty: Difficulty = 'normal', seed = 11, world: WorldSpec = w): GameState {
  return createGame(world, {
    seed,
    difficulty,
    mapGenerator: generateArea,
    ...(n > 1 ? { players: Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` })) } : {}),
  });
}

const ctxOf = (s: GameState): Ctx => ({ world: w, ix: indexWorld(w), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: generateArea, depth: 0 });
const rats = (s: GameState) => s.area.actors.filter((a) => a.defId === 'rat');
const floorUnits = (s: GameState) => s.area.items.reduce((n, fi) => n + fi.item.count, 0);
const players = (s: GameState) => s.party.map((id) => s.area.actors.find((a) => a.id === s.players[id].actorId)!);

describe('party scaling', () => {
  it('partyFactor is 1 + k·(n − 1)', () => {
    expect(partyFactor(1, 0.35)).toBe(1);
    expect(partyFactor(4, 0.5)).toBe(2.5);
    expect(partyFactor(12, PARTY_SCALING.mapArea)).toBeCloseTo(2.65);
  });

  it('a party of one is built exactly as before parties', () => {
    const s = game(1);
    expect(s.area.partySize).toBeUndefined();
    expect(s.area.gmBudget).toBe(10);
    expect(s.area.map.width).toBe(32);
    expect(s.area.map.height).toBe(24);
    expect(rats(s)).toHaveLength(3);
    for (const r of rats(s)) expect(r.maxHp).toBe(5);
    expect(floorUnits(s)).toBe(4);
    expect(areaActorCap(ctxOf(s))).toBe(MAX_AREA_ACTORS);
    // same seed, same game
    expect(JSON.stringify(game(1))).toBe(JSON.stringify(s));
  });

  it.each([
    // n, rats (min·f, up to max·f with extras·f), rat hp, floor units, GM budget, actor cap
    [2, 5, 7, 6, 13, 70],
    [4, 9, 10, 10, 18, 90],
    [12, 24, 22, 26, 38, 170],
  ])('a party of %i: bigger map, more and tougher hostiles, more items and GM budget', (n, ratCount, ratHp, units, budget, cap) => {
    const s = game(n);
    expect(s.area.partySize).toBe(n);
    expect({ width: s.area.map.width, height: s.area.map.height }).toEqual(mapDimensions('small', n));
    expect(rats(s)).toHaveLength(ratCount);
    for (const r of rats(s)) expect(r.maxHp).toBe(ratHp);
    expect(floorUnits(s)).toBe(units);
    expect(s.area.gmBudget).toBe(budget);
    expect(areaActorCap(ctxOf(s))).toBe(cap);
    expect(invariantError(w, s)).toBeNull();
  });

  it('the band and the party multiply: Hard for four players', () => {
    const s = game(4, 'hard');
    // 5 × 1.15 × 1.9
    for (const r of rats(s)) expect(r.maxHp).toBe(11);
  });

  it('spawned hostiles keep 3 tiles from every player', () => {
    for (const seed of [1, 2, 3]) {
      const s = game(8, 'normal', seed);
      const ps = players(s).map((a) => a.pos);
      for (const r of rats(s)) for (const p of ps) expect(Math.max(Math.abs(r.pos.x - p.x), Math.abs(r.pos.y - p.y))).toBeGreaterThan(3);
    }
  });

  it('bosses get the unique factor, also in a later phase; GM spawns and summons are scaled too', () => {
    const s = game(4);
    const c = ctxOf(s);
    const free = s.area.map.tiles.findIndex((t, i) => t.kind === 'floor' && !s.area.actors.some((a) => a.pos.y * s.area.map.width + a.pos.x === i));
    const pos = { x: free % s.area.map.width, y: Math.floor(free / s.area.map.width) };
    const boss = spawnActor(c, 'boss', pos)!;
    // 20 × 1.25 (UNIQUE_HOSTILE_HP) × 3.4 (uniqueHp 0.8, MP2 C1)
    expect(boss.maxHp).toBe(85);
    expect(transformActor(c, boss, 'boss2')).toBe(true);
    // 30 × 1.25 × 3.4
    expect(boss.maxHp).toBe(128);
    expect(boss.hp).toBe(128);
    // a GM spawn goes through the same path
    const r = applyGmActions(s, [{ type: 'spawn', actor: 'archer', count: 1, near: 'random' }], { world: w, mapGenerator: generateArea });
    const archer = r.state.area.actors.find((a) => a.defId === 'archer')!;
    // 8 × 1.9
    expect(archer.maxHp).toBe(15);
  });

  it('a late joiner counts from the next area: the current one keeps its size', () => {
    const s = game(2);
    const r = addPlayer(s, { name: 'Late' }, { world: w, mapGenerator: generateArea });
    expect(r.state.party).toHaveLength(3);
    expect(r.state.area.partySize).toBe(2);
    expect(r.state.area.gmBudget).toBe(s.area.gmBudget);
  });

  it('a kill weighs 1/f on a violence counter in a party area, so its lose condition is as far away', () => {
    const vw = testWorld((x) => {
      x.areas[0].actors = [{ actor: 'rat', weight: 10, min: 2, max: 3 }];
      x.rules = [{ id: 'count', name: 'Count', description: 'd', switches: { violenceCounter: 'kills' } }];
    });
    const killAll = (n: number, count: number) => {
      const s = game(n, 'normal', 11, vw);
      const c: Ctx = { world: vw, ix: indexWorld(vw), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: generateArea, depth: 0 };
      const killer = players(s)[0];
      for (let i = 0; i < count; i++) {
        const free = s.area.map.tiles.findIndex((t, j) => t.kind === 'floor' && !s.area.actors.some((a) => a.pos.y * s.area.map.width + a.pos.x === j));
        const rat = spawnActor(c, 'rat', { x: free % s.area.map.width, y: Math.floor(free / s.area.map.width) })!;
        rat.hp = 0;
        killActor(c, rat, killer.id);
      }
      return s.counters.kills ?? 0;
    };
    expect(killAll(1, 7)).toBe(7);
    // f = 1.65 for two players: 7 kills count 4 (7 / 1.65 = 4.2)
    expect(killAll(2, 7)).toBe(4);
    // f = 2.95 for four
    expect(killAll(4, 59)).toBe(20);
  });

  it('NPCs are not scaled', () => {
    const s = game(4);
    const c = ctxOf(s);
    const free = s.area.map.tiles.findIndex((t, i) => t.kind === 'floor' && !s.area.actors.some((a) => a.pos.y * s.area.map.width + a.pos.x === i));
    const sage = spawnActor(c, 'sage', { x: free % s.area.map.width, y: Math.floor(free / s.area.map.width) })!;
    expect(sage.maxHp).toBe(10);
  });
});
