/**
 * Wall cut-away: which tall tiles must be lowered so the player (and whoever stands next to them)
 * is never hidden. Pure function of the map, the player tile and the camera's 90° yaw step.
 *
 * A tile at offset (dx, dy) from a focus tile has a camera-space depth d (how far it lies towards
 * the camera) and a lateral offset l. Tiles with 0 < d ≤ depth and |l| ≤ halfWidth + (d-1)·spread
 * form a wedge between the focus and the camera; tall tiles inside it are lowered.
 *
 * Focus tiles:
 * - the player's tile: the full wedge, plus the tile itself (an open door's lintel, a tall walkable
 *   terrain or a transition model on the player's own tile hides the player too);
 * - each of the player's 8 neighbours: a narrow wedge (`around`), so a wall or door between the
 *   camera and an adjacent enemy is cleared even when it lies beside or behind the player. The
 *   neighbour tile itself is not lowered (it may be a wall the player stands against);
 * - `focus`: extra tiles that hold something worth seeing (adjacent actors): a narrow wedge plus the
 *   tile itself.
 *
 * `occluderTiles` handles everything farther away: it lowers the tall tiles that actually cross the
 * 3D line between a visible actor and the camera (perspective makes that line slant sideways for
 * actors off the screen centre, so a straight wedge would miss the wall that hides them).
 */
import type { Pos } from '../../engine/types';
import { towardCamera } from './coords';

export interface CutawayOptions {
  depth?: number;
  halfWidth?: number;
  spread?: number;
  /** half width of the wedges cast from the player's 8 neighbours; false disables them (default 0.5) */
  around?: number | false;
  /** extra occupied tiles to keep clear (their own tile + a narrow wedge) */
  focus?: readonly Pos[];
}

export interface CutawayMap {
  width: number;
  height: number;
  /** returns true if the tile at index is tall enough to hide things (walls, tall terrain, door frames, exit models) */
  isTall: (index: number) => boolean;
}

export function cutawayTiles(map: CutawayMap, player: Pos, yawStep: number, opts: CutawayOptions = {}): Set<number> {
  const depth = opts.depth ?? 5;
  const halfWidth = opts.halfWidth ?? 1.5;
  const spread = opts.spread ?? 0.75;
  const around = opts.around === false ? null : opts.around ?? 0.5;
  const { dx: cx, dy: cy } = towardCamera(yawStep);
  const out = new Set<number>();

  const add = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return;
    const idx = y * map.width + x;
    if (map.isTall(idx)) out.add(idx);
  };

  const wedge = (from: Pos, hw: number, self: boolean): void => {
    if (self) add(from.x, from.y);
    const reach = Math.ceil(depth + hw + depth * spread) + 1;
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const d = ox * cx + oy * cy;
        if (d <= 0 || d > depth) continue;
        const l = ox * cy - oy * cx;
        if (Math.abs(l) > hw + (d - 1) * spread) continue;
        add(from.x + ox, from.y + oy);
      }
    }
  };

  wedge(player, halfWidth, true);
  const narrow = around ?? 0.5;
  if (around !== null) {
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) if (ox || oy) wedge({ x: player.x + ox, y: player.y + oy }, narrow, false);
  }
  for (const f of opts.focus ?? []) wedge(f, narrow, true);
  return out;
}

export interface OccluderOptions {
  /** height of the thing to keep visible (world units; a tile is 1) */
  height: number;
  /** height of tall tiles (walls, tall terrain); anything below the line of sight is ignored */
  tallHeight: number;
  /** half width of the thing (its silhouette is sampled at the centre and ± this, across the view) */
  radius?: number;
}

/**
 * Tall tiles that hide (part of) an object standing on `target` from a camera at `eye`, where world
 * (x, y, z) = (tile x, height, tile y) and tiles are unit cells centred on integer coordinates.
 * Samples the object's feet, middle and top at its centre and both sides, and walks each sight line
 * towards the eye until it clears `tallHeight`. The target's own tile is never included. Adds to `out`.
 */
export function occluderTiles(
  map: CutawayMap,
  target: Pos,
  eye: { x: number; y: number; z: number },
  opts: OccluderOptions,
  out: Set<number> = new Set(),
): Set<number> {
  const H = opts.tallHeight;
  const r = opts.radius ?? 0.3;
  const dxE = eye.x - target.x;
  const dzE = eye.z - target.y;
  const flat = Math.hypot(dxE, dzE);
  if (flat < 1e-6 || eye.y <= 0) return out;
  // across-view unit vector (perpendicular to the ground direction towards the eye)
  const px = -dzE / flat;
  const pz = dxE / flat;
  const STEP = 0.05;
  const self = target.y * map.width + target.x;
  for (const side of [-r, 0, r]) {
    for (const h of [0.05, opts.height * 0.5, opts.height]) {
      const sx = target.x + px * side;
      const sz = target.y + pz * side;
      if (h >= H) continue; // already above every tall tile
      const ex = eye.x - sx;
      const ey = eye.y - h;
      const ez = eye.z - sz;
      const len = Math.hypot(ex, ez);
      if (ey <= 0) continue;
      // fraction of the segment at which the line rises above H
      const tMax = Math.min(1, (H - h) / ey);
      const steps = Math.ceil((tMax * len) / STEP);
      for (let k = 1; k <= steps; k++) {
        const t = (k / steps) * tMax;
        const x = Math.round(sx + ex * t);
        const y = Math.round(sz + ez * t);
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const idx = y * map.width + x;
        if (idx !== self && map.isTall(idx)) out.add(idx);
      }
    }
  }
  return out;
}
