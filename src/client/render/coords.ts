/**
 * Tile ↔ world mapping. A tile (x, y) occupies the unit square centred on world (x, 0, y):
 * map x → world +x (east), map y → world +z (south). The floor surface is at world y = 0.
 */
import type { Pos } from '../../engine/types';

export interface Vec2 {
  x: number;
  z: number;
}

export function tileCentre(p: Pos): Vec2 {
  return { x: p.x, z: p.y };
}

export function worldToTile(x: number, z: number): Pos {
  return { x: Math.round(x), y: Math.round(z) };
}

/** Normalise a 90° camera step to 0..3. */
export function normStep(step: number): number {
  return ((step % 4) + 4) % 4;
}

/**
 * Unit vector (in tile/world xz) from the camera target towards the camera for a yaw step.
 * Step 0 = camera south of the target looking north; each +1 rotates the camera 90° clockwise
 * seen from above (south → west → north → east).
 */
export function towardCamera(step: number): { dx: number; dy: number } {
  switch (normStep(step)) {
    case 0:
      return { dx: 0, dy: 1 };
    case 1:
      return { dx: -1, dy: 0 };
    case 2:
      return { dx: 0, dy: -1 };
    default:
      return { dx: 1, dy: 0 };
  }
}

/** Yaw angle (radians) of the camera offset for a step: offset = (sin yaw, cos yaw). */
export function yawForStep(step: number): number {
  return -step * (Math.PI / 2);
}

/** Facing angle (rotation.y) for a model that should look from `from` towards `to` (models face +z). */
export function facingAngle(from: Pos, to: Pos): number | null {
  const dx = to.x - from.x;
  const dz = to.y - from.y;
  if (dx === 0 && dz === 0) return null;
  return Math.atan2(dx, dz);
}

export function inBounds(p: Pos, width: number, height: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
}
