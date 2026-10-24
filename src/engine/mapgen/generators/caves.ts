/**
 * Caves: cellular automata (4-5 rule with early open-space filling), tiny pockets dropped and
 * remaining chambers tunnelled together, occasional underground pools.
 */
import type { GenContext } from '../context';
import { canBlockLocally } from '../grid';

export function genCaves(ctx: GenContext): void {
  const { g, rng } = ctx;
  const openness = ctx.param('openness', 0.5, 0, 1);
  const fill = Math.max(0.36, Math.min(0.56, 0.47 - (openness - 0.5) * 0.2));
  const iterations = Math.round(ctx.param(['smoothing', 'iterations'], 5, 2, 8));
  const W = g.w;
  const H = g.h;
  let wall = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const border = x < 1 || y < 1 || x >= W - 1 || y >= H - 1;
      wall[y * W + x] = border || rng.chance(fill) ? 1 : 0;
    }
  const count = (src: Uint8Array, x: number, y: number, r: number) => {
    let n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || src[ny * W + nx]) n++;
      }
    return n;
  };
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) {
          next[y * W + x] = 1;
          continue;
        }
        const n1 = count(wall, x, y, 1) + wall[y * W + x]; // 3x3 including self (4-5 rule)
        if (it < 2) {
          const n2 = count(wall, x, y, 2);
          next[y * W + x] = n1 >= 5 || n2 <= 2 ? 1 : 0;
        } else next[y * W + x] = n1 >= 5 ? 1 : 0;
      }
    wall = next;
  }
  let open = 0;
  for (let i = 0; i < W * H; i++) if (!wall[i]) open++;
  // degenerate fill: carve a winding gallery so there is always a cave to play in
  if (open < (W - 2) * (H - 2) * 0.25) {
    let x = 3;
    let y = rng.int(3, H - 4);
    while (x < W - 3) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) wall[(y + dy) * W + x + dx] = 0;
      x++;
      y = Math.max(3, Math.min(H - 4, y + rng.int(-1, 1)));
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.set(x, y, wall[y * W + x] ? 'wall' : 'floor');

  // pools
  if (rng.chance(ctx.param('pools', 0.35, 0, 1))) {
    const passable = (x: number, y: number) => g.passable(x, y);
    const pools = rng.int(1, 2);
    for (let k = 0; k < pools; k++) {
      let x = rng.int(3, W - 4);
      let y = rng.int(3, H - 4);
      for (let t = 0; t < 30; t++) {
        if (g.kind(x, y) === 'floor' && canBlockLocally(passable, x, y)) g.set(x, y, 'water');
        x = Math.max(2, Math.min(W - 3, x + rng.int(-1, 1)));
        y = Math.max(2, Math.min(H - 3, y + rng.int(-1, 1)));
      }
    }
  }
  ctx.dropBelow = 8;
  ctx.voronoi = 80;
  ctx.carveDoors = false;
}
