/**
 * Placement helpers for the engine: picking spawn positions and scattering custom terrain
 * without ever cutting the map apart.
 */
import type { AreaPlan, WorldSpec } from '../../schema/world';
import type { AreaMap, Pos, Rng, Tile } from '../types';
import { DIRS4, PASSABLE_KINDS, bfsDistances, canBlockLocally, isPassableTile, posKey } from './grid';

export type PlacementWhere = 'anywhere' | 'near_start' | 'near_exit' | 'far' | 'centre' | 'guarded';

export interface PlacementOptions {
  /** terrain ids that are not walkable (tiles covered by them are never chosen nor crossed) */
  blockedTerrain?: ReadonlySet<string>;
}

function at(map: AreaMap, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return map.tiles[y * map.width + x];
}

/** BFS distance field (4-connected) from `from` over passable tiles; -1 = unreachable. */
export function distanceField(map: AreaMap, from: Pos | Pos[], blockedTerrain?: ReadonlySet<string>): Int32Array {
  const sources = (Array.isArray(from) ? from : [from]).map((p) => p.y * map.width + p.x);
  return bfsDistances(map.width, map.height, (i) => isPassableTile(map.tiles[i], blockedTerrain), sources);
}

/**
 * Finds a free floor tile for an actor or item. `occupied` holds "x,y" keys (see posKey) that
 * must be avoided. Never returns start, exit or door tiles; returns null when nothing fits.
 */
export function findPlacement(
  map: AreaMap,
  where: PlacementWhere,
  rng: Rng,
  occupied: Set<string>,
  opts: PlacementOptions = {},
): Pos | null {
  const blocked = opts.blockedTerrain;
  const dStart = distanceField(map, map.start, blocked);
  const dExit = distanceField(map, map.exit, blocked);
  const all: { p: Pos; i: number; terrain: boolean }[] = [];
  for (let y = 1; y < map.height - 1; y++)
    for (let x = 1; x < map.width - 1; x++) {
      const i = y * map.width + x;
      const t = map.tiles[i];
      if (t.kind !== 'floor' || dStart[i] < 0) continue;
      if (blocked && t.terrain !== undefined && blocked.has(t.terrain)) continue;
      if (occupied.has(`${x},${y}`)) continue;
      all.push({ p: { x, y }, i, terrain: t.terrain !== undefined });
    }
  if (!all.length) return null;
  // prefer plain floor; fall back to (walkable) terrain tiles
  const plain = all.filter((c) => !c.terrain);
  const cands = plain.length ? plain : all;
  let maxD = 0;
  for (const c of cands) if (dStart[c.i] > maxD) maxD = dStart[c.i];
  const pick = <T>(arr: T[]): T => arr[rng.int(0, arr.length - 1)];
  const nearest = (score: (c: (typeof cands)[number]) => number, n: number) => {
    const sorted = [...cands].sort((a, b) => score(a) - score(b) || a.i - b.i);
    return pick(sorted.slice(0, Math.max(1, n))).p;
  };
  switch (where) {
    case 'near_start': {
      const ring = cands.filter((c) => dStart[c.i] >= 2 && dStart[c.i] <= 6);
      return ring.length ? pick(ring).p : nearest((c) => dStart[c.i] || 999, 6);
    }
    case 'near_exit': {
      const ring = cands.filter((c) => dExit[c.i] >= 1 && dExit[c.i] <= 5);
      return ring.length ? pick(ring).p : nearest((c) => (dExit[c.i] >= 0 ? dExit[c.i] : 9999), 6);
    }
    case 'far': {
      const far = cands.filter((c) => dStart[c.i] >= maxD * 0.65);
      return far.length ? pick(far).p : nearest((c) => -dStart[c.i], 6);
    }
    case 'centre': {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < map.tiles.length; i++) {
        if (dStart[i] < 0) continue;
        sx += i % map.width;
        sy += Math.floor(i / map.width);
        n++;
      }
      const mx = sx / n;
      const my = sy / n;
      return nearest((c) => (c.p.x - mx) ** 2 + (c.p.y - my) ** 2, 6);
    }
    case 'guarded': {
      // far from the start, inside a room/zone that is not the start's, preferably in an alcove
      const startRegion = at(map, map.start.x, map.start.y)?.region;
      const pool = cands.filter((c) => dStart[c.i] >= maxD * 0.5);
      const scored = (pool.length ? pool : cands).map((c) => {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const t = at(map, c.p.x + dx, c.p.y + dy);
            if (!t || !PASSABLE_KINDS.has(t.kind)) walls++;
          }
        const region = map.tiles[c.i].region;
        const roomBonus = region !== undefined && region !== startRegion ? 2 : 0;
        return { c, s: walls + roomBonus + dStart[c.i] / Math.max(1, maxD) };
      });
      scored.sort((a, b) => b.s - a.s || a.c.i - b.c.i);
      return pick(scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.1)))).c.p;
    }
    case 'anywhere':
    default: {
      const away = cands.filter((c) => dStart[c.i] >= 4);
      return (away.length ? pick(away) : pick(cands)).p;
    }
  }
}

/**
 * Scatters a terrain over plain floor tiles in small clusters and returns the changed positions.
 * `terrain` may be a bare id (treated conservatively as blocking) or `{ id, walkable }`.
 * Blocking terrain is only placed where it keeps every reachable tile reachable, never on or
 * right next to start/exit, and never in front of doors. `blockedTerrain` lists terrain ids
 * already on the map that block movement.
 */
export function scatterTerrain(
  map: AreaMap,
  terrain: string | { id: string; walkable?: boolean },
  density: number,
  rng: Rng,
  blockedTerrain?: ReadonlySet<string>,
): Pos[] {
  const id = typeof terrain === 'string' ? terrain : terrain.id;
  const walkable = typeof terrain === 'string' ? false : terrain.walkable !== false;
  const blocked = new Set(blockedTerrain ?? []);
  if (!walkable) blocked.add(id);
  const W = map.width;
  const passable = (x: number, y: number) => {
    const t = at(map, x, y);
    return !!t && isPassableTile(t, blocked);
  };
  const eligible = (x: number, y: number): boolean => {
    const t = at(map, x, y);
    if (!t || t.kind !== 'floor' || t.terrain !== undefined) return false;
    if (x < 1 || y < 1 || x > W - 2 || y > map.height - 2) return false;
    if (Math.max(Math.abs(x - map.start.x), Math.abs(y - map.start.y)) <= 1) return false;
    if (Math.max(Math.abs(x - map.exit.x), Math.abs(y - map.exit.y)) <= 1) return false;
    if (!walkable) {
      for (const [dx, dy] of DIRS4) {
        const n = at(map, x + dx, y + dy);
        if (n && n.kind !== 'floor' && PASSABLE_KINDS.has(n.kind)) return false; // doors, start, exit
      }
      if (!canBlockLocally(passable, x, y)) return false;
    }
    return true;
  };
  const cands: Pos[] = [];
  for (let y = 1; y < map.height - 1; y++) for (let x = 1; x < W - 1; x++) if (eligible(x, y)) cands.push({ x, y });
  const target = Math.round(cands.length * Math.max(0, Math.min(1, density)));
  const placed: Pos[] = [];
  if (!target) return placed;
  for (let attempt = 0; attempt < target * 8 && placed.length < target && cands.length; attempt++) {
    let { x, y } = cands[rng.int(0, cands.length - 1)];
    const cluster = rng.int(1, 5);
    for (let k = 0; k < cluster && placed.length < target; k++) {
      if (eligible(x, y)) {
        map.tiles[y * W + x].terrain = id;
        placed.push({ x, y });
      }
      const [dx, dy] = DIRS4[rng.int(0, 3)];
      x += dx;
      y += dy;
    }
  }
  return placed;
}

/** Applies every `plan.terrain` entry using the world's terrain definitions. */
export function applyAreaTerrain(map: AreaMap, plan: Pick<AreaPlan, 'terrain'>, world: Pick<WorldSpec, 'terrains'>, rng: Rng): Pos[] {
  const defs = new Map((world.terrains ?? []).map((t) => [t.id, t]));
  const blocked = new Set<string>();
  for (const t of world.terrains ?? []) if (t.walkable === false) blocked.add(t.id);
  const out: Pos[] = [];
  for (const entry of plan.terrain ?? []) {
    const def = defs.get(entry.terrain);
    const walkable = def ? def.walkable !== false : false;
    out.push(...scatterTerrain(map, { id: entry.terrain, walkable }, entry.density ?? 0.03, rng, blocked));
  }
  return out;
}

export { posKey };
