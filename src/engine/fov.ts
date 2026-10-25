/**
 * Field of view: symmetric shadowcasting (Albert Ford's algorithm) with exact rational slopes,
 * plus a cheap symmetric line-of-sight test for targeting and AI.
 */
import type { Pos } from './types';
import { line } from './util';

interface Frac {
  n: number;
  d: number;
}

type Opaque = (x: number, y: number) => boolean;

/**
 * Computes the set of visible tile indices (y * width + x) from `origin` within `radius`.
 * `opaque` must return true for out-of-bounds coordinates too (or they're clipped here).
 */
export function computeFov(width: number, height: number, origin: Pos, radius: number, opaque: Opaque): Set<number> {
  const visible = new Set<number>();
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inb(origin.x, origin.y)) return visible;
  visible.add(origin.y * width + origin.x);
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return visible;
  const r2 = r * r + r;
  const isOpaque = (x: number, y: number) => !inb(x, y) || opaque(x, y);

  // quadrant transforms: (depth, col) → (x, y)
  const quads: ((depth: number, col: number) => [number, number])[] = [
    (d, c) => [origin.x + c, origin.y - d], // north
    (d, c) => [origin.x + d, origin.y + c], // east
    (d, c) => [origin.x + c, origin.y + d], // south
    (d, c) => [origin.x - d, origin.y + c], // west
  ];

  for (const tr of quads) {
    const reveal = (depth: number, col: number) => {
      const [x, y] = tr(depth, col);
      if (!inb(x, y)) return;
      if (depth * depth + col * col > r2) return;
      visible.add(y * width + x);
    };
    const wallAt = (depth: number, col: number) => {
      const [x, y] = tr(depth, col);
      return isOpaque(x, y);
    };
    // explicit stack instead of recursion
    const stack: { depth: number; start: Frac; end: Frac }[] = [{ depth: 1, start: { n: -1, d: 1 }, end: { n: 1, d: 1 } }];
    while (stack.length) {
      const row = stack.pop()!;
      if (row.depth > r) continue;
      let start = row.start;
      const end = row.end;
      const depth = row.depth;
      // round_ties_up(depth * start), round_ties_down(depth * end)
      const minCol = Math.floor((2 * depth * start.n + start.d) / (2 * start.d));
      const maxCol = Math.ceil((2 * depth * end.n - end.d) / (2 * end.d));
      let prevWall: boolean | null = null;
      for (let col = minCol; col <= maxCol; col++) {
        const wall = wallAt(depth, col);
        const symmetric = col * start.d >= depth * start.n && col * end.d <= depth * end.n;
        if (wall || symmetric) reveal(depth, col);
        if (prevWall === true && !wall) start = { n: 2 * col - 1, d: 2 * depth };
        if (prevWall === false && wall) {
          stack.push({ depth: depth + 1, start, end: { n: 2 * col - 1, d: 2 * depth } });
        }
        prevWall = wall;
      }
      if (prevWall === false) stack.push({ depth: depth + 1, start, end });
    }
  }
  return visible;
}

/**
 * True when `b` is within radius `r` of `a` by the same Euclidean rule computeFov uses
 * (dx² + dy² ≤ r² + r). Sight and perception use it, so an actor notices exactly the tiles a
 * sight of the same radius shows (never the far corners of the square).
 */
export function withinRadius(a: Pos, b: Pos, r: number): boolean {
  const rr = Math.max(0, Math.floor(r));
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= rr * rr + rr;
}

/**
 * True when `b` is at most `r` steps from `a` (Chebyshev distance: a diagonal step counts as one,
 * exactly like movement). Weapon and ability reach use it, so "reaches 5 tiles" means five steps
 * in any direction, the distance a player counts on the grid (issues/M5-ranged-reach-metric.md).
 * Shots still need line of sight, and hostiles only shoot the player from tiles the player sees
 * (vision.playerSeesTile), so a reach longer than the sight circle never hits from the dark.
 */
export function withinReach(a: Pos, b: Pos, r: number): boolean {
  const rr = Math.max(0, Math.floor(r));
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= rr;
}

/** True when the straight line a→b (excluding endpoints) has no opaque tile, in either direction. */
export function hasLos(a: Pos, b: Pos, opaque: Opaque): boolean {
  if (a.x === b.x && a.y === b.y) return true;
  const clear = (p: Pos[]) => {
    for (let i = 1; i < p.length - 1; i++) if (opaque(p[i].x, p[i].y)) return false;
    return true;
  };
  return clear(line(a, b)) || clear(line(b, a));
}
