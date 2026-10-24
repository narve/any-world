/**
 * Open field: an irregular blob-shaped clearing with scattered cover (rocks, thickets, wall
 * stubs, fences) and the odd pond. Obstacles are placed only where they keep the field connected.
 */
import type { GenContext } from '../context';
import { canBlockLocally } from '../grid';

export function genOpen(ctx: GenContext): void {
  const { g, rng } = ctx;
  const cx = (g.w - 1) / 2;
  const cy = (g.h - 1) / 2;
  const rx = (g.w - 3) / 2;
  const ry = (g.h - 3) / 2;
  const harmonics = [2, 3, 5, 7].map((k) => ({ k, amp: 0.03 + rng.next() * 0.05, phase: rng.next() * Math.PI * 2 }));
  // squarer than an ellipse so the field uses the map: superellipse exponent
  const p = 3 + rng.next() * 1.5;
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const a = Math.atan2(dy, dx);
      let f = 0.92;
      for (const h of harmonics) f += h.amp * Math.sin(h.k * a + h.phase);
      f = Math.min(f, 1);
      const r = Math.pow(Math.pow(Math.abs(dx), p) + Math.pow(Math.abs(dy), p), 1 / p);
      if (r <= f) g.set(x, y, 'floor');
    }

  const passable = (x: number, y: number) => g.passable(x, y);
  const block = (x: number, y: number, kind: 'wall' | 'water' = 'wall') => {
    if (!g.inInterior(x, y) || g.kind(x, y) !== 'floor') return false;
    if (!canBlockLocally(passable, x, y)) return false;
    g.set(x, y, kind, null);
    return true;
  };

  const openness = ctx.param('openness', 1 - ctx.param(['cover', 'coverDensity'], 0.08, 0, 0.5) * 4, 0, 1);
  const floorCount = g.countPassable();
  const coverTiles = Math.round(floorCount * (1 - openness) * 0.16 + floorCount * 0.02);
  const rockiness = ctx.param('rockiness', 0.4, 0, 1);
  let placed = 0;
  for (let attempt = 0; attempt < coverTiles * 6 && placed < coverTiles; attempt++) {
    const x = rng.int(2, g.w - 3);
    const y = rng.int(2, g.h - 3);
    if (g.kind(x, y) !== 'floor') continue;
    const roll = rng.next();
    if (roll < rockiness * 0.6) {
      // boulder 1x1 or 2x2
      const big = rng.chance(0.4);
      for (const [ox, oy] of big ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]]) if (block(x + ox, y + oy)) placed++;
    } else if (roll < 0.75) {
      // straight cover line (fence, hedge, low wall), length 3..6
      const horiz = rng.chance(0.5);
      const len = rng.int(3, 6);
      for (let k = 0; k < len; k++) if (block(horiz ? x + k : x, horiz ? y : y + k)) placed++;
    } else {
      // thicket blob
      let bx = x;
      let by = y;
      const n = rng.int(3, 6);
      for (let k = 0; k < n; k++) {
        if (block(bx, by)) placed++;
        bx += rng.int(-1, 1);
        by += rng.int(-1, 1);
      }
    }
  }
  // ponds
  const ponds = ctx.param('ponds', rng.chance(0.45) ? rng.int(1, 2) : 0, 0, 4);
  for (let k = 0; k < ponds; k++) {
    let x = rng.int(4, g.w - 5);
    let y = rng.int(4, g.h - 5);
    const n = rng.int(6, 16);
    for (let t = 0; t < n * 3 && n > 0; t++) {
      block(x, y, 'water');
      x = Math.max(3, Math.min(g.w - 4, x + rng.int(-1, 1)));
      y = Math.max(3, Math.min(g.h - 4, y + rng.int(-1, 1)));
    }
  }
  ctx.voronoi = 110;
  ctx.carveDoors = false;
}
