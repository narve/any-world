/** Player field of view → area.seen (0 unseen, 1 remembered, 2 visible) and region discovery. */
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

export function updateFov(ctx: Ctx): void {
  const area = ctx.s.area;
  const map = area.map;
  const seen = area.seen;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 2) seen[i] = 1;
  const p = playerActor(ctx);
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
