/**
 * Player field of view → area.seen (0 unseen, 1 remembered, 2 visible) and region discovery.
 * Stepping into a room (a map region) also remembers its whole layout, walls and doors included,
 * without showing who is in it (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §4: fog as memory).
 */
import { type Ctx, emit, opaque, playerActor } from './ctx';
import { computeFov, withinRadius } from './fov';
import type { Pos } from './types';
import { sightRadius } from './stats';

/**
 * Whether the player can see tile `pos` right now (a fresh field of view from where the player
 * stands, so it is correct mid-round after pushes, teleports or new smoke). Hostiles only strike
 * the player from beyond arm's reach when standing on such a tile, so every attack the player
 * takes comes from somewhere the player can see.
 */
export function playerSeesTile(ctx: Ctx, pos: Pos): boolean {
  const map = ctx.s.area.map;
  const p = playerActor(ctx);
  const r = sightRadius(ctx, p);
  if (!withinRadius(p.pos, pos, r)) return false;
  return playerFov(ctx, r).has(pos.y * map.width + pos.x);
}

/**
 * The player's field of view (tile indices) with sight radius `r`, cached on the context until
 * the player moves, the radius changes or a tile changes (every tile write goes through mutTile,
 * which bumps ctx.tileWrites; a new area brings a new tile array).
 */
function playerFov(ctx: Ctx, r: number): Set<number> {
  const map = ctx.s.area.map;
  const p = playerActor(ctx);
  const c = ctx.fovCache;
  const writes = ctx.tileWrites ?? 0;
  if (c && c.tiles === map.tiles && c.writes === writes && c.x === p.pos.x && c.y === p.pos.y && c.r === r) return c.vis;
  const vis = computeFov(map.width, map.height, p.pos, r, (x, y) => opaque(ctx, x, y));
  ctx.fovCache = { tiles: map.tiles, writes, x: p.pos.x, y: p.pos.y, r, vis };
  return vis;
}

/**
 * Regions larger than this are open ground (a town's main street, an arena floor), not rooms: their
 * layout is not handed over on entry.
 */
export const ROOM_MEMORY_MAX_TILES = 150;

/** tiles of each room-sized region plus the solid tiles around them, per map (tile arrays are per area) */
const roomTiles = new WeakMap<object, Map<number, number[]>>();

function regionLayout(ctx: Ctx, region: number): number[] {
  const map = ctx.s.area.map;
  let byRegion = roomTiles.get(map.tiles);
  if (!byRegion) {
    byRegion = new Map();
    const W = map.width;
    const H = map.height;
    for (let i = 0; i < map.tiles.length; i++) {
      const r = map.tiles[i].region;
      if (r === undefined) continue;
      let list = byRegion.get(r);
      if (!list) byRegion.set(r, (list = []));
      list.push(i);
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && map.tiles[ny * W + nx].region !== r) list.push(ny * W + nx);
        }
    }
    for (const [r, list] of byRegion) {
      let floor = 0;
      for (const i of list) if (map.tiles[i].region === r) floor++;
      if (floor > ROOM_MEMORY_MAX_TILES) byRegion.set(r, []);
    }
    roomTiles.set(map.tiles, byRegion);
  }
  return byRegion.get(region) ?? [];
}

/** remember the layout of the room the player stands in (seen 0 → 1; nothing becomes visible) */
function rememberRoom(ctx: Ctx): void {
  const area = ctx.s.area;
  const p = playerActor(ctx);
  const r = area.map.tiles[p.pos.y * area.map.width + p.pos.x]?.region;
  if (r === undefined) return;
  for (const i of regionLayout(ctx, r)) if (area.seen[i] === 0) area.seen[i] = 1;
}

export function updateFov(ctx: Ctx): void {
  const area = ctx.s.area;
  const map = area.map;
  const seen = area.seen;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 2) seen[i] = 1;
  const p = playerActor(ctx);
  rememberRoom(ctx);
  const vis = playerFov(ctx, sightRadius(ctx, p));
  const known = new Set(area.discoveredRegions);
  const valid = new Set(map.regions.map((r) => r.id));
  for (const i of vis) {
    seen[i] = 2;
    const r = map.tiles[i].region;
    if (r !== undefined && !known.has(r) && valid.has(r)) {
      known.add(r);
      area.discoveredRegions.push(r);
      emit(ctx, { type: 'region_discovered', regionId: r });
    }
  }
}
