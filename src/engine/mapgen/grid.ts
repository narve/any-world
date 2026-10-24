/**
 * Shared grid primitives for the map generators. Pure & deterministic.
 */
import type { AreaMap, Pos, Rng, Tile, TileKind } from '../types';

/** Tile kinds an actor can stand on / walk through (closed doors open on bump). */
export const PASSABLE_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(['floor', 'door', 'door_open', 'start', 'transition']);

export function isPassableKind(kind: TileKind): boolean {
  return PASSABLE_KINDS.has(kind);
}

/** Passable for connectivity purposes: walkable kind and not covered by a blocking terrain. */
export function isPassableTile(tile: Tile, blockedTerrain?: ReadonlySet<string>): boolean {
  if (!PASSABLE_KINDS.has(tile.kind)) return false;
  if (blockedTerrain && tile.terrain !== undefined && blockedTerrain.has(tile.terrain)) return false;
  return true;
}

export const DIRS4: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Ring of the 8 neighbours in cyclic order: N, NE, E, SE, S, SW, W, NW. */
export const RING8: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function posKey(p: Pos): string {
  return `${p.x},${p.y}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Mutable working grid used while generating. */
export class Grid {
  readonly w: number;
  readonly h: number;
  readonly tiles: Tile[];
  private nextRegion = 0;

  constructor(w: number, h: number, fill: TileKind = 'void') {
    this.w = w;
    this.h = h;
    this.tiles = new Array(w * h);
    for (let i = 0; i < w * h; i++) this.tiles[i] = { kind: fill };
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** inside the 1-tile border */
  inInterior(x: number, y: number): boolean {
    return x >= 1 && y >= 1 && x < this.w - 1 && y < this.h - 1;
  }

  isBorder(x: number, y: number): boolean {
    return x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1;
  }

  kind(x: number, y: number): TileKind {
    if (!this.inBounds(x, y)) return 'void';
    return this.tiles[y * this.w + x].kind;
  }

  tile(x: number, y: number): Tile {
    return this.tiles[y * this.w + x];
  }

  passable(x: number, y: number): boolean {
    return this.inBounds(x, y) && PASSABLE_KINDS.has(this.tiles[y * this.w + x].kind);
  }

  /** set kind; region is set when given, cleared when `null`. */
  set(x: number, y: number, kind: TileKind, region?: number | null): void {
    if (!this.inBounds(x, y)) return;
    const t = this.tiles[y * this.w + x];
    t.kind = kind;
    if (region === null) delete t.region;
    else if (region !== undefined) t.region = region;
  }

  /** fill an inclusive rectangle, clipped to the map. */
  fillRect(x1: number, y1: number, x2: number, y2: number, kind: TileKind, region?: number | null): void {
    for (let y = Math.max(0, y1); y <= Math.min(this.h - 1, y2); y++)
      for (let x = Math.max(0, x1); x <= Math.min(this.w - 1, x2); x++) this.set(x, y, kind, region);
  }

  newRegion(): number {
    return this.nextRegion++;
  }

  regionCount(): number {
    return this.nextRegion;
  }

  countPassable(): number {
    let n = 0;
    for (const t of this.tiles) if (PASSABLE_KINDS.has(t.kind)) n++;
    return n;
  }
}

/**
 * True if turning the passable tile at (x,y) into an obstacle cannot disconnect anything:
 * all of its passable orthogonal neighbours stay connected through the surrounding ring.
 */
export function canBlockLocally(passable: (x: number, y: number) => boolean, x: number, y: number): boolean {
  if (!passable(x, y)) return false;
  const p: boolean[] = RING8.map(([dx, dy]) => passable(x + dx, y + dy));
  // orthogonal positions in RING8 are 0,2,4,6
  let orthCount = 0;
  for (let i = 0; i < 8; i += 2) if (p[i]) orthCount++;
  if (orthCount === 0) return false; // isolated tile — leave it alone
  // walk the ring; consecutive passable cells are 4-adjacent (orthogonal<->diagonal neighbours)
  // count runs of passable cells that contain an orthogonal neighbour
  let start = -1;
  for (let i = 0; i < 8; i++) if (!p[i]) { start = i; break; }
  if (start === -1) return true; // fully surrounded by passable
  let runsWithOrth = 0;
  let inRun = false;
  let runHasOrth = false;
  for (let k = 1; k <= 8; k++) {
    const i = (start + k) % 8;
    if (p[i]) {
      if (!inRun) { inRun = true; runHasOrth = false; }
      if (i % 2 === 0) runHasOrth = true;
    } else if (inRun) {
      inRun = false;
      if (runHasOrth) runsWithOrth++;
    }
  }
  if (inRun && runHasOrth) runsWithOrth++;
  // a diagonal alone between two blocked orthogonals is not connected to anything 4-wise,
  // so runs without orthogonal members do not matter.
  return runsWithOrth <= 1;
}

/** 4-connected component labels over passable tiles; -1 for non-passable. */
export function components(
  w: number,
  h: number,
  passable: (i: number) => boolean,
): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== -1 || !passable(i)) continue;
    const id = sizes.length;
    let size = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const cx = c % w;
      const cy = (c - cx) / w;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (labels[n] === -1 && passable(n)) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** BFS (4-connected) distances over passable tiles; -1 = unreachable. */
export function bfsDistances(w: number, h: number, passable: (i: number) => boolean, sources: number[]): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const s of sources) {
    if (dist[s] !== -1) continue;
    dist[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const c = queue[head++];
    const cx = c % w;
    const cy = (c - cx) / w;
    const d = dist[c] + 1;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (dist[n] === -1 && passable(n)) {
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

/** Minimal binary min-heap keyed by number. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(val: number, key: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  /** returns the value with the smallest key */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const lastK = keys.pop()!;
    const lastV = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastK) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastK;
      vals[i] = lastV;
    }
    return top;
  }
}

/**
 * Dijkstra from `sources` to the first tile satisfying `isTarget`. `cost(i)` is the cost of
 * entering tile i (Infinity = blocked). Returns the path (indices, source first) or null.
 */
export function dijkstraPath(
  w: number,
  h: number,
  sources: number[],
  isTarget: (i: number) => boolean,
  cost: (i: number) => number,
): number[] | null {
  const dist = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const heap = new MinHeap();
  for (const s of sources) {
    dist[s] = 0;
    heap.push(s, 0);
  }
  while (heap.size) {
    const c = heap.pop();
    if (isTarget(c)) {
      const path: number[] = [];
      for (let p = c; p !== -1; p = prev[p]) path.push(p);
      path.reverse();
      return path;
    }
    const cx = c % w;
    const cy = (c - cx) / w;
    const dc = dist[c];
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      const k = cost(n);
      if (k === Infinity) continue;
      const nd = dc + k;
      if (nd < dist[n]) {
        dist[n] = nd;
        prev[n] = c;
        heap.push(n, nd);
      }
    }
  }
  return null;
}

/** Converts a working grid into the public AreaMap shape (start/exit filled in by finalize). */
export function toAreaMap(g: Grid, start: Pos, exit: Pos, regions: AreaMap['regions']): AreaMap {
  return { width: g.w, height: g.h, tiles: g.tiles, start, exit, regions };
}
