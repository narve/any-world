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
  if (!withinRadius(p.pos, pos, sightRadius(ctx, p))) return false;
  const vis = computeFov(map.width, map.height, p.pos, sightRadius(ctx, p), (x, y) => opaque(ctx, x, y));
  return vis.has(pos.y * map.width + pos.x);
}

export function updateFov(ctx: Ctx): void {
  const area = ctx.s.area;
  const map = area.map;
  const seen = area.seen;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 2) seen[i] = 1;
  const p = playerActor(ctx);
  const vis = computeFov(map.width, map.height, p.pos, sightRadius(ctx, p), (x, y) => opaque(ctx, x, y));
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
