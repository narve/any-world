/** Small pure helpers shared by the engine modules. */
import type { AreaMap, Dir, Pos, Tile } from './types';

export const DIRS: Record<Dir, readonly [number, number]> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
};
export const DIR_LIST: readonly Dir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

export function dirFromDelta(dx: number, dy: number): Dir | null {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  for (const d of DIR_LIST) if (DIRS[d][0] === sx && DIRS[d][1] === sy) return d;
  return null;
}

export function addDir(p: Pos, d: Dir): Pos {
  return { x: p.x + DIRS[d][0], y: p.y + DIRS[d][1] };
}

/** Chebyshev distance (8-way moves) */
export function cheb(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function dist2(a: Pos, b: Pos): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

export function samePos(a: Pos | undefined | null, b: Pos | undefined | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

export function inBounds(map: AreaMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function idx(map: AreaMap, x: number, y: number): number {
  return y * map.width + x;
}

export function tileAt(map: AreaMap, x: number, y: number): Tile | undefined {
  return inBounds(map, x, y) ? map.tiles[y * map.width + x] : undefined;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function isValidPos(p: unknown): p is Pos {
  return (
    !!p &&
    typeof p === 'object' &&
    Number.isInteger((p as Pos).x) &&
    Number.isInteger((p as Pos).y)
  );
}

/** Bresenham line from a to b inclusive. */
export function line(a: Pos, b: Pos): Pos[] {
  const pts: Pos[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 1000; guard++) {
    pts.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return pts;
}

/** capitalise first letter (for log lines that start with a name) */
export function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** FNV-1a 32-bit hash → 8 hex chars */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * An own property of a plain id-keyed record (GameState counters, flags, defeated, resources,
 * knowledge, cooldowns, vocabulary maps), or undefined. `obj[id]` alone would return inherited
 * Object.prototype members for ids such as "constructor" (a function, not a count), which turns
 * every later sum into a string and every compare into NaN (M5 issue proto-ids).
 */
export function own<T>(obj: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
