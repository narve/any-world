/** Grid pathfinding: A* (8-directional, octile heuristic) and BFS distance maps. */
import type { Pos } from './types';

type Passable = (x: number, y: number) => boolean;
type Cost = (x: number, y: number) => number;

const NB: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, p: number): void {
    const it = this.items;
    const pr = this.prio;
    it.push(item);
    pr.push(p);
    let i = it.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= pr[i]) break;
      [it[parent], it[i]] = [it[i], it[parent]];
      [pr[parent], pr[i]] = [pr[i], pr[parent]];
      i = parent;
    }
  }
  pop(): number {
    const it = this.items;
    const pr = this.prio;
    const top = it[0];
    const lastI = it.pop()!;
    const lastP = pr.pop()!;
    if (it.length) {
      it[0] = lastI;
      pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < it.length && pr[l] < pr[m]) m = l;
        if (r < it.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i], it[m]];
        [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface PathOptions {
  /** allow the goal tile itself to be impassable (e.g. occupied by the target) */
  goalAlwaysPassable?: boolean;
  /** max expanded nodes before giving up */
  maxNodes?: number;
  /** extra per-tile cost multiplier (>=1) */
  cost?: Cost;
}

/** A* path from → to. Returns the steps (excluding `from`, including `to`) or null. */
export function findPath(width: number, height: number, from: Pos, to: Pos, passable: Passable, opts: PathOptions = {}): Pos[] | null {
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inb(from.x, from.y) || !inb(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const goal = to.y * width + to.x;
  const start = from.y * width + from.x;
  const maxNodes = opts.maxNodes ?? width * height;
  const g = new Float64Array(width * height).fill(Infinity);
  const came = new Int32Array(width * height).fill(-1);
  const closed = new Uint8Array(width * height);
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + 0.001 * Math.min(dx, dy);
  };
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, h(from.x, from.y));
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxNodes) return null;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (const [dx, dy] of NB) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = ny * width + nx;
      if (closed[ni]) continue;
      const isGoal = ni === goal;
      if (!passable(nx, ny) && !(isGoal && opts.goalAlwaysPassable)) continue;
      const step = (dx !== 0 && dy !== 0 ? 1.0001 : 1) * (opts.cost ? Math.max(1, opts.cost(nx, ny)) : 1);
      const ng = g[cur] + step;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + h(nx, ny));
      }
    }
  }
  if (came[goal] === -1) return null;
  const path: Pos[] = [];
  let c = goal;
  while (c !== start && c !== -1) {
    const x = c % width;
    path.push({ x, y: (c - x) / width });
    c = came[c];
  }
  path.reverse();
  return path;
}

/** BFS (8-dir) step distances from `from`; -1 = unreachable. */
export function bfsDistances(width: number, height: number, from: Pos | Pos[], passable: Passable): Int32Array {
  const dist = new Int32Array(width * height).fill(-1);
  const queue: number[] = [];
  for (const p of Array.isArray(from) ? from : [from]) {
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
    const i = p.y * width + p.x;
    if (dist[i] === -1) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (const [dx, dy] of NB) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (dist[ni] !== -1 || !passable(nx, ny)) continue;
      dist[ni] = dist[cur] + 1;
      queue.push(ni);
    }
  }
  return dist;
}
