/**
 * Player field of view → PlayerState.seen (0 unseen, 1 remembered, 2 visible) and region discovery.
 * Stepping into a room (a map region) also remembers its whole layout, walls and doors included,
 * without showing who is in it (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §4: fog as memory).
 */
import { type Ctx, emit, me, opaque, playerActor, playerActorOf, timed, withPlayer } from './ctx';
import { own } from './util';
import { computeFov, withinRadius } from './fov';
import type { ActorInstance, PlayerId, Pos } from './types';
import { sightRadius } from './stats';

/**
 * Whether player `pid` can see tile `pos` right now (a fresh field of view from where they stand,
 * so it is correct mid-round after pushes, teleports or new smoke). Hostiles only strike a player
 * from beyond arm's reach when standing on a tile *that* player sees, so every attack a player
 * takes comes from somewhere they can see. False for a player whose actor is not standing.
 */
export function playerSeesTile(ctx: Ctx, pid: PlayerId, pos: Pos): boolean {
  const map = ctx.s.area.map;
  const p = playerActorOf(ctx, pid);
  if (!p || p.hp <= 0) return false;
  const r = sightRadius(ctx, p);
  if (!withinRadius(p.pos, pos, r)) return false;
  return playerFov(ctx, pid, p, r).has(pos.y * map.width + pos.x);
}

/** whether any standing player sees tile `pos` (GM placement: nothing appears out of everyone's sight) */
export function partySeesTile(ctx: Ctx, pos: Pos): boolean {
  return ctx.s.party.some((id) => !ctx.s.players[id].down && playerSeesTile(ctx, id, pos));
}

/**
 * A player's field of view (tile indices) with sight radius `r`, cached on the context per player
 * until they move, the radius changes or a tile changes (every tile write goes through mutTile,
 * which bumps ctx.tileWrites; a new area brings a new tile array).
 */
function playerFov(ctx: Ctx, pid: PlayerId, p: ActorInstance, r: number): Set<number> {
  const map = ctx.s.area.map;
  const cache = (ctx.fovCache ??= {});
  const c = own(cache, pid);
  const writes = ctx.tileWrites ?? 0;
  if (c && c.tiles === map.tiles && c.writes === writes && c.x === p.pos.x && c.y === p.pos.y && c.r === r) return c.vis;
  const vis = computeFov(map.width, map.height, p.pos, r, (x, y) => opaque(ctx, x, y));
  cache[pid] = { tiles: map.tiles, writes, x: p.pos.x, y: p.pos.y, r, vis };
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
  const seen = me(ctx).seen;
  for (const i of regionLayout(ctx, r)) if (seen[i] === 0) seen[i] = 1;
}

/**
 * Every player's fog, in party order (each with its own cached field of view): visible tiles
 * become remembered, the current field of view visible. Players whose actor is not in the area
 * are skipped.
 */
export function updateFov(ctx: Ctx): void {
  timed(ctx, 'fov', () => {
    for (const id of ctx.s.party) if (playerActorOf(ctx, id)) withPlayer(ctx, id, () => updatePlayerFov(ctx));
  });
}

/** the acting player's fog */
function updatePlayerFov(ctx: Ctx): void {
  const area = ctx.s.area;
  const map = area.map;
  const seen = me(ctx).seen;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 2) seen[i] = 1;
  const p = playerActor(ctx);
  rememberRoom(ctx);
  const vis = playerFov(ctx, ctx.pid, p, sightRadius(ctx, p));
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
