/**
 * Shape helpers shared by the non-realistic generators (islands, organic, geometric):
 * seeded value noise, a spanning tree over points and 4-connected line carving. Pure &
 * deterministic: every random draw comes from the Rng passed in.
 */
import type { Rng } from '../types';

/** Smooth 2-D value noise in [-1, 1] on a lattice of `cell` tiles, seeded from `rng` once. */
export function valueNoise(rng: Rng, w: number, h: number, cell: number): (x: number, y: number) => number {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const lattice = new Float64Array(gw * gh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next() * 2 - 1;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = Math.max(0, x) / cell;
    const fy = Math.max(0, y) / cell;
    const ix = Math.min(gw - 2, Math.floor(fx));
    const iy = Math.min(gh - 2, Math.floor(fy));
    const tx = smooth(fx - ix);
    const ty = smooth(fy - iy);
    const a = lattice[iy * gw + ix];
    const b = lattice[iy * gw + ix + 1];
    const c = lattice[(iy + 1) * gw + ix];
    const d = lattice[(iy + 1) * gw + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** Union-find over 0..n-1. */
export class DisjointSet {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  /** joins the sets; returns false when they were already joined */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
    return true;
  }
}

export interface WeightedEdge {
  a: number;
  b: number;
  w: number;
}

/**
 * Kruskal spanning tree over `n` nodes. Returns [tree edges, remaining edges], both in
 * ascending weight order (ties keep input order, so results are deterministic).
 */
export function spanningTree(n: number, edges: WeightedEdge[]): [WeightedEdge[], WeightedEdge[]] {
  const sorted = edges.map((e, i) => ({ e, i })).sort((p, q) => p.e.w - q.e.w || p.i - q.i).map((p) => p.e);
  const ds = new DisjointSet(n);
  const tree: WeightedEdge[] = [];
  const rest: WeightedEdge[] = [];
  for (const e of sorted) (ds.union(e.a, e.b) ? tree : rest).push(e);
  return [tree, rest];
}

/**
 * 4-connected staircase line from (x0,y0) to (x1,y1) (both included): follows the straight
 * line as closely as possible while every step is orthogonal.
 */
export function line4(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const out = [{ x: x0, y: y0 }];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  let ix = 0;
  let iy = 0;
  while (ix < dx || iy < dy) {
    // step along the axis whose progress lags behind the ideal line
    const stepX = iy >= dy || (ix < dx && (ix + 0.5) / dx < (iy + 0.5) / dy);
    if (stepX) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    out.push({ x, y });
  }
  return out;
}

/** Distance from point p to segment ab. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + vx * t - px;
  const qy = ay + vy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}
