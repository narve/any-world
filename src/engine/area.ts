/**
 * Areas: entering an area (generate or inject a map), placing terrain, actors (spawn tables +
 * guaranteed placements), items (tables + placed items), carrying allies along, transition locks.
 */
import type { AreaPlan } from '../schema/world';
import { GM_BUDGET_PER_AREA } from '../schema/gm';
import type { ActorInstance, AreaMap, Pos } from './types';
import { type Ctx, emit, isPlayer, logKey, me, playerActor, tileWalkable } from './ctx';
import { spawnActor } from './actors';
import { dropItemAt } from './inventory';
import { fireTriggers } from './triggers';
import { evalCondition } from './conditions';
import { updateFov } from './vision';
import { bfsDistances } from './path';
import { applyAreaTerrain } from './mapgen/index';
import { cheb, clone, inBounds, samePos } from './util';

const EXTRA_SPAWNS: Record<string, number> = { small: 2, medium: 4, large: 6 };

/** makes sure a map is usable: tiles length, start/exit in bounds and marked */
export function normaliseMap(map: AreaMap): AreaMap {
  const m = clone(map);
  if (!Array.isArray(m.tiles) || m.tiles.length !== m.width * m.height) throw new Error('map tiles do not match width × height');
  if (!inBounds(m, m.start.x, m.start.y) || !inBounds(m, m.exit.x, m.exit.y)) throw new Error('map start/exit out of bounds');
  m.regions = Array.isArray(m.regions) ? m.regions : [];
  const s = m.tiles[m.start.y * m.width + m.start.x];
  if (s.kind !== 'start') s.kind = 'start';
  const e = m.tiles[m.exit.y * m.width + m.exit.x];
  if (e.kind !== 'transition') e.kind = 'transition';
  delete s.terrain;
  delete e.terrain;
  return m;
}

interface Placement {
  /** BFS distance from start (−1 unreachable) */
  fromStart: Int32Array;
  fromExit: Int32Array;
  /** reachable, unoccupied plain floor tiles (not start/exit) */
  floor: Pos[];
}

function walk(ctx: Ctx) {
  const map = ctx.s.area.map;
  return (x: number, y: number) => tileWalkable(ctx, map.tiles[y * map.width + x]);
}

function computePlacement(ctx: Ctx): Placement {
  const map = ctx.s.area.map;
  const pass = walk(ctx);
  const fromStart = bfsDistances(map.width, map.height, map.start, pass);
  const fromExit = bfsDistances(map.width, map.height, map.exit, pass);
  const floor: Pos[] = [];
  for (let i = 0; i < map.tiles.length; i++) {
    if (fromStart[i] < 0) continue;
    const t = map.tiles[i];
    if (t.kind !== 'floor' || !tileWalkable(ctx, t)) continue;
    const x = i % map.width;
    floor.push({ x, y: (i - x) / map.width });
  }
  return { fromStart, fromExit, floor };
}

function occupied(ctx: Ctx, p: Pos): boolean {
  return ctx.s.area.actors.some((a) => samePos(a.pos, p));
}

type Where = 'anywhere' | 'near_start' | 'near_exit' | 'far' | 'centre' | 'guarded';

function choosePos(ctx: Ctx, pl: Placement, where: Where, forItem = false): Pos | null {
  const map = ctx.s.area.map;
  const W = map.width;
  const free = pl.floor.filter((p) => (forItem ? !ctx.s.area.items.some((fi) => samePos(fi.pos, p)) : !occupied(ctx, p)));
  if (!free.length) return null;
  const ds = (p: Pos) => pl.fromStart[p.y * W + p.x];
  const de = (p: Pos) => pl.fromExit[p.y * W + p.x];
  switch (where) {
    case 'near_start': {
      const c = free.filter((p) => ds(p) >= 2 && ds(p) <= 7);
      if (c.length) return ctx.rng.pick(c);
      return [...free].sort((a, b) => ds(a) - ds(b))[0];
    }
    case 'near_exit': {
      const c = free.filter((p) => de(p) >= 1 && de(p) <= 5);
      if (c.length) return ctx.rng.pick(c);
      return [...free].sort((a, b) => de(a) - de(b))[0];
    }
    case 'far': {
      const sorted = [...free].sort((a, b) => ds(b) - ds(a));
      return ctx.rng.pick(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1))));
    }
    case 'centre': {
      const c = { x: map.width / 2, y: map.height / 2 };
      const sorted = [...free].sort((a, b) => (a.x - c.x) ** 2 + (a.y - c.y) ** 2 - ((b.x - c.x) ** 2 + (b.y - c.y) ** 2));
      return ctx.rng.pick(sorted.slice(0, Math.min(5, sorted.length)));
    }
    case 'guarded': {
      const guards = ctx.s.area.actors.filter((a) => a.faction === 'hostile' && !isPlayer(ctx, a));
      const uniques = guards.filter((a) => ctx.ix.actors.get(a.defId)?.unique);
      const pool = uniques.length ? uniques : guards;
      if (pool.length) {
        const strongest = [...pool].sort((a, b) => b.maxHp - a.maxHp)[0];
        const c = free.filter((p) => cheb(p, strongest.pos) <= 2);
        if (c.length) return ctx.rng.pick(c);
      }
      return choosePos(ctx, pl, 'far', forItem);
    }
    default: {
      const c = free.filter((p) => ds(p) >= 6);
      return ctx.rng.pick(c.length ? c : free);
    }
  }
}

function placeTerrain(ctx: Ctx, plan: AreaPlan): void {
  const map = ctx.s.area.map;
  if (map.tiles.some((t) => t.terrain)) return; // the generator already placed terrain
  if (!plan.terrain.length) return;
  try {
    applyAreaTerrain(map, plan, ctx.world, ctx.rng);
    return;
  } catch {
    for (const t of map.tiles) delete t.terrain;
  }
  placeTerrainFallback(ctx, plan);
}

/** own scatter (8-connected check) used only if mapgen's applyAreaTerrain fails */
function placeTerrainFallback(ctx: Ctx, plan: AreaPlan): void {
  const map = ctx.s.area.map;
  const pass = walk(ctx);
  for (const entry of plan.terrain) {
    const td = ctx.ix.terrains.get(entry.terrain);
    if (!td) continue;
    const pl = computePlacement(ctx);
    const cands = pl.floor.filter((p) => cheb(p, map.start) > 1 && cheb(p, map.exit) > 1);
    let n = Math.round(entry.density * cands.length);
    if (n === 0 && entry.density > 0 && cands.length) n = 1;
    ctx.rng.shuffle(cands);
    let placed = 0;
    for (const p of cands) {
      if (placed >= n) break;
      const t = map.tiles[p.y * map.width + p.x];
      if (t.terrain) continue;
      t.terrain = td.id;
      if (!td.walkable) {
        const d = bfsDistances(map.width, map.height, map.start, pass);
        if (d[map.exit.y * map.width + map.exit.x] < 0) {
          delete t.terrain;
          continue;
        }
      }
      placed++;
    }
  }
}

function placeActors(ctx: Ctx, plan: AreaPlan): void {
  const pl = computePlacement(ctx);
  for (const pa of plan.placed) {
    const p = choosePos(ctx, pl, pa.where);
    if (p) spawnActor(ctx, pa.actor, p, { randomEnergy: true, silent: true, uncapped: true });
  }
  // spawn table: every entry's minimum, then weighted extras up to the size budget
  const entries = plan.actors.filter((e) => ctx.ix.actors.has(e.actor));
  const counts = entries.map(() => 0);
  const spawnOne = (k: number): boolean => {
    const p = choosePos(ctx, pl, 'anywhere');
    if (!p) return false;
    const a = spawnActor(ctx, entries[k].actor, p, { randomEnergy: true, silent: true, uncapped: true });
    counts[k]++;
    return !!a;
  };
  entries.forEach((e, k) => {
    for (let i = 0; i < e.min; i++) spawnOne(k);
  });
  const extra = EXTRA_SPAWNS[plan.size] ?? 4;
  for (let i = 0; i < extra; i++) {
    const weights = entries.map((e, k) => (counts[k] < Math.max(e.min, e.max) ? e.weight : 0));
    const k = ctx.rng.weighted(weights);
    if (k < 0) break;
    spawnOne(k);
  }
}

function placeItems(ctx: Ctx, plan: AreaPlan): void {
  const pl = computePlacement(ctx);
  for (const pi of plan.placedItems) {
    if (!ctx.ix.items.has(pi.item)) continue;
    const p = choosePos(ctx, pl, pi.where, true);
    if (p) dropItemAt(ctx, pi.item, 1, p);
  }
  const table = plan.items.filter((e) => ctx.ix.items.has(e.item));
  for (let i = 0; i < plan.itemCount; i++) {
    const k = ctx.rng.weighted(table.map((e) => e.weight));
    if (k < 0) break;
    const p = choosePos(ctx, pl, 'anywhere', true);
    if (!p) break;
    dropItemAt(ctx, table[k].item, 1, p);
  }
}

/**
 * Enters area `index`: builds the map (injected or generated), places the player at the start,
 * brings nearby allies along, populates the area and fires on_area_enter.
 */
export function enterArea(ctx: Ctx, index: number, injected?: AreaMap): void {
  const plan = ctx.world.areas[index];
  if (!plan) throw new Error(`no area ${index}`);
  const map = normaliseMap(injected ?? ctx.mapGen(plan, ctx.world, ctx.rng));
  const prev = ctx.s.area;
  const player = prev?.actors.find((a) => a.id === me(ctx).actorId);
  if (!player) throw new Error('player actor missing');
  // the rest of the party comes along (party order), and every player's allies close to them
  const others: ActorInstance[] = [];
  for (const id of ctx.s.party) {
    const a = prev.actors.find((x) => x.id === ctx.s.players[id].actorId);
    if (a && a !== player) others.push(a);
  }
  const owners = [player, ...others];
  const allies: ActorInstance[] = prev
    ? prev.actors.filter((a) => a.hp > 0 && owners.some((o) => a.allyOf === o.id && cheb(a.pos, o.pos) <= 4))
    : [];
  player.pos = { ...map.start };
  ctx.s.area = {
    index,
    map,
    actors: [player],
    items: [],
    discoveredRegions: [],
    gmBudget: GM_BUDGET_PER_AREA,
  };
  for (const id of ctx.s.party) ctx.s.players[id].seen = new Uint8Array(map.width * map.height);
  placeTerrain(ctx, plan);
  // teammates before allies and spawns, on the nearest free floor to the start (reachable, so
  // nobody lands behind a wall); a party of one places exactly as before
  for (const o of others) {
    const p = nearestFreeFloor(ctx, map.start) ?? { ...map.start };
    o.pos = p;
    ctx.s.area.actors.push(o);
  }
  for (const al of allies) {
    const p = nearestFreeFloor(ctx, map.start);
    if (!p) continue;
    al.pos = p;
    al.ai.home = { ...p };
    delete al.ai.lastSeen;
    ctx.s.area.actors.push(al);
  }
  placeActors(ctx, plan);
  placeItems(ctx, plan);
  emit(ctx, { type: 'area_entered', index });
  logKey(ctx, 'log.area.enter', { area: ctx.world.vocabulary.area, number: index + 1, name: plan.name }, 'system');
  updateFov(ctx);
  fireTriggers(ctx, player, 'on_area_enter', { pos: player.pos });
  updateFov(ctx);
}

/** the nearest reachable, unoccupied plain floor tile to `from` (BFS; `from` itself excluded) */
export function nearestFreeFloor(ctx: Ctx, from: Pos): Pos | null {
  const map = ctx.s.area.map;
  const d = bfsDistances(map.width, map.height, from, walk(ctx));
  let best: Pos | null = null;
  let bd = Infinity;
  for (let i = 0; i < d.length; i++) {
    if (d[i] <= 0 || d[i] >= bd) continue;
    const x = i % map.width;
    const p = { x, y: (i - x) / map.width };
    if (map.tiles[i].kind !== 'floor' || occupied(ctx, p)) continue;
    best = p;
    bd = d[i];
  }
  return best;
}

/** null if the transition can be taken now, else a reason */
export function transitionFailure(ctx: Ctx): string | null {
  const p = playerActor(ctx);
  const map = ctx.s.area.map;
  const t = map.tiles[p.pos.y * map.width + p.pos.x];
  if (!samePos(p.pos, map.exit) && t?.kind !== 'transition') return 'not at the way onward';
  const plan = ctx.world.areas[ctx.s.area.index];
  if (ctx.s.area.index >= ctx.world.areas.length - 1) return 'there is nowhere further to go';
  if (plan.transitionRequires && !evalCondition(ctx, plan.transitionRequires, { self: p })) return lockedReason(ctx);
  return null;
}

/** transitionFailure's reason when the current area's way onward is locked */
export function lockedReason(ctx: Ctx): string {
  return `${ctx.world.areas[ctx.s.area.index]?.transitionName ?? ''}: locked`;
}
