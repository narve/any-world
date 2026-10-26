/**
 * Islands: irregular floating platforms of varied size scattered over the void, joined by
 * 1-wide bridges. A spanning tree of the shortest gaps keeps everything connected; a few extra
 * bridges make circuits, and some leaf platforms are left as dead-end side pockets (good spots
 * for loot or something guarded). Platforms end directly at the void (no wall rim) unless
 * `rims` is set, so the backdrop shows between them.
 *
 * Knobs (plan.params; all optional, out-of-range values are clamped):
 *   islandCount  3..24   number of platforms (default 6 / 9 / 12 for small / medium / large)
 *   islandSize   0..1    how much of the map the platforms cover, and their average size (0.5)
 *   bridgeLength 2..24   preferred longest bridge in tiles; also spreads platforms apart (8)
 *   loops        0..1    share of extra bridges that form circuits (0.2)
 *   pockets      0..1    share of leaf platforms kept as single-bridge side pockets (0.35)
 *   outcrops     0..1    chance that a large platform carries a solid outcrop / pillar (0.3)
 *   rims         0 | 1   1 = wall rim (railing, hull, membrane) around every platform (0)
 *
 * Region names: "platform", "large platform", "small platform", and "secluded platform" for
 * dead ends reached by a single bridge (side pockets).
 */
import { bySize, type GenContext } from '../context';
import { DIRS4, RING8, canBlockLocally, clamp, components, shuffle } from '../grid';
import { line4, spanningTree, type WeightedEdge } from '../shapes';

interface Island {
  cx: number;
  cy: number;
  r: number;
  tiles: number[];
  region: number;
}

export function genIslands(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const W = g.w;
  const H = g.h;
  const count = Math.round(ctx.param(['islandCount', 'islands'], bySize(size, 6, 9, 12) + rng.int(-1, 1), 3, 24));
  const sizeScale = ctx.param(['islandSize', 'size'], 0.5, 0, 1);
  const bridgeLength = Math.round(ctx.param(['bridgeLength', 'bridgeMax'], 8, 2, 24));
  const loops = ctx.param('loops', 0.2, 0, 1);
  const pocketShare = ctx.param(['pockets', 'deadEnds'], 0.35, 0, 1);
  const outcrops = ctx.param(['outcrops', 'cover'], 0.3, 0, 1);
  const rims = ctx.param(['rims', 'edges', 'railings'], 0, 0, 1) >= 0.5;

  // ---- platform layout -------------------------------------------------------------------
  const lo = 2; // keep x,y in [2, W-3] so a rim and the closed border always fit
  const interior = (W - 2 * lo) * (H - 2 * lo);
  const coverage = 0.3 + sizeScale * 0.16;
  const meanR = clamp(Math.sqrt((interior * coverage) / count / Math.PI), 1.8, 10);
  const minGap = clamp(Math.round(bridgeLength / 4), 2, 5);
  const owner = new Int32Array(W * H).fill(-1);
  const islands: Island[] = [];
  for (let k = 0; k < count; k++) {
    // one dominant platform, the rest varied
    let r = meanR * (k === 0 ? 1.3 + rng.next() * 0.2 : 0.55 + rng.next() * 0.75);
    let gap = minGap;
    let placed: { x: number; y: number } | null = null;
    // best of a few valid candidates (farthest from the others) spreads platforms over the map
    let bestScore = -1;
    let valid = 0;
    for (let attempt = 0; attempt < 120 && valid < 6; attempt++) {
      if (attempt > 0 && attempt % 20 === 0 && valid === 0) {
        r = Math.max(1.5, r * 0.85);
        gap = Math.max(2, gap - 1);
      }
      const m = Math.min(r * 0.7, Math.min(W, H) / 2 - lo - 1);
      const x = lo + m + rng.next() * (W - 1 - 2 * lo - 2 * m);
      const y = lo + m + rng.next() * (H - 1 - 2 * lo - 2 * m);
      let nearest = Infinity;
      for (const o of islands) nearest = Math.min(nearest, Math.hypot(o.cx - x, o.cy - y) - (o.r + r) * 0.95 - gap);
      if (nearest < 0) continue;
      valid++;
      const score = Math.min(nearest, 1e6);
      if (score > bestScore) {
        bestScore = score;
        placed = { x, y };
      }
    }
    if (!placed) continue;
    const id = islands.length;
    const isl: Island = { cx: placed.x, cy: placed.y, r, tiles: [], region: -1 };
    paintIsland(ctx, isl, id, owner, lo);
    if (isl.tiles.length >= 4) {
      isl.region = g.newRegion();
      for (const i of isl.tiles) g.tiles[i].region = isl.region;
      islands.push(isl);
    } else for (const i of isl.tiles) {
      owner[i] = -1;
      g.tiles[i].kind = 'void';
    }
  }
  if (islands.length < 2) throw new Error('islands: could not place platforms');

  // ---- bridges ----------------------------------------------------------------------------
  const edgeTiles = islands.map((isl, id) =>
    isl.tiles.filter((i) => {
      const x = i % W;
      const y = (i - x) / W;
      return DIRS4.some(([dx, dy]) => owner[(y + dy) * W + x + dx] !== id);
    }),
  );
  const links: (WeightedEdge & { from: number; to: number; len: number })[] = [];
  for (let a = 0; a < islands.length; a++)
    for (let b = a + 1; b < islands.length; b++) {
      let best = Infinity;
      let from = -1;
      let to = -1;
      for (const i of edgeTiles[a]) {
        const ix = i % W;
        const iy = (i - ix) / W;
        for (const j of edgeTiles[b]) {
          const jx = j % W;
          const jy = (j - jx) / W;
          const dx = Math.abs(ix - jx);
          const dy = Math.abs(iy - jy);
          // straight bridges read best; a bend costs a little
          const score = dx + dy + (dx && dy ? 0.6 : 0);
          if (score < best) {
            best = score;
            from = i;
            to = j;
          }
        }
      }
      const len = Math.round(best) - 1;
      links.push({ a, b, w: best + (len > bridgeLength ? 100 + len : 0), from, to, len });
    }
  const [tree, rest] = spanningTree(islands.length, links) as [typeof links, typeof links];
  const degree = new Array<number>(islands.length).fill(0);
  for (const e of tree) {
    degree[e.a]++;
    degree[e.b]++;
  }
  // dead-end side pockets: leaves of the tree that receive no extra bridges
  const leaves = islands.map((_, i) => i).filter((i) => degree[i] === 1);
  const pockets = new Set<number>();
  for (const i of leaves) if (rng.chance(pocketShare)) pockets.add(i);
  if (pocketShare > 0 && pockets.size === 0 && leaves.length && islands.length >= 4) pockets.add(rng.pick(leaves));
  const bridges = [...tree];
  const maxExtra = Math.ceil(islands.length * loops);
  for (const e of rest) {
    if (bridges.length - tree.length >= maxExtra) break;
    if (e.len > bridgeLength || pockets.has(e.a) || pockets.has(e.b)) continue;
    if (rng.chance(loops)) bridges.push(e);
  }
  bridges.forEach((e, k) => carveBridge(ctx, owner, e, k < tree.length));

  // ---- outcrops on the larger platforms ----------------------------------------------------
  const passable = (x: number, y: number) => g.passable(x, y);
  for (const isl of islands) {
    if (isl.tiles.length < 30 || !rng.chance(outcrops)) continue;
    const inner = isl.tiles.filter((i) => {
      const x = i % W;
      const y = (i - x) / W;
      return RING8.every(([dx, dy]) => g.tiles[(y + dy) * W + x + dx].region === isl.region);
    });
    if (!inner.length) continue;
    let c = rng.pick(inner);
    const n = rng.int(1, 4);
    for (let k = 0; k < n; k++) {
      const x = c % W;
      const y = (c - x) / W;
      if (g.tiles[c].region === isl.region && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
      const [dx, dy] = rng.pick(DIRS4);
      c = (y + dy) * W + x + dx;
    }
  }

  // ---- names ------------------------------------------------------------------------------
  // a platform is "secluded" when exactly one bridge tile touches it (a true dead end; a
  // bridge between two other platforms may happen to cross a planned pocket)
  const meanArea = islands.reduce((s, i) => s + i.tiles.length, 0) / islands.length;
  for (const isl of islands) {
    const entries = new Set<number>();
    for (const i of isl.tiles) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIRS4) {
        const n = (y + dy) * W + x + dx;
        if (g.tiles[n].kind === 'floor' && g.tiles[n].region === undefined) entries.add(n);
      }
    }
    const name =
      entries.size === 1
        ? 'secluded platform'
        : isl.tiles.length >= meanArea * 1.5
          ? 'large platform'
          : isl.tiles.length <= meanArea * 0.6
            ? 'small platform'
            : 'platform';
    ctx.regionNames.set(isl.region, name);
  }

  ctx.openEdges = !rims;
  ctx.carveDoors = false;
  // side pockets are dead ends on purpose
  ctx.pruneSpurs = 0;
  ctx.shortcuts = 0;
  ctx.dropBelow = 0;
  ctx.voronoi = 0;
}

/** Paints one irregular platform (wobbly, possibly elongated disc) without touching others. */
function paintIsland(ctx: GenContext, isl: Island, id: number, owner: Int32Array, lo: number): void {
  const { g, rng } = ctx;
  const W = g.w;
  const harmonics = [2, 3, 4, 5].map((k) => ({ k, amp: (0.04 + rng.next() * 0.1) / (k - 1), phase: rng.next() * Math.PI * 2 }));
  const stretch = 0.75 + rng.next() * 0.55;
  const rot = rng.next() * Math.PI;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const reach = Math.ceil(isl.r * 1.6) + 1;
  const painted: number[] = [];
  for (let y = Math.max(lo, Math.floor(isl.cy - reach)); y <= Math.min(g.h - 1 - lo, Math.ceil(isl.cy + reach)); y++)
    for (let x = Math.max(lo, Math.floor(isl.cx - reach)); x <= Math.min(W - 1 - lo, Math.ceil(isl.cx + reach)); x++) {
      const dx = x - isl.cx;
      const dy = y - isl.cy;
      const u = (dx * cos + dy * sin) / stretch;
      const v = (-dx * sin + dy * cos) * stretch;
      const a = Math.atan2(v, u);
      let f = 1;
      for (const h of harmonics) f += h.amp * Math.sin(h.k * a + h.phase);
      if (Math.hypot(u, v) > isl.r * f) continue;
      // never touch (even diagonally) another platform: bridges are the only links
      if (RING8.some(([ox, oy]) => {
        const o = owner[(y + oy) * W + x + ox];
        return o !== -1 && o !== id;
      }))
        continue;
      if (owner[y * W + x] !== -1) continue;
      owner[y * W + x] = id;
      painted.push(y * W + x);
    }
  // keep the largest 4-connected piece
  const mine = new Uint8Array(W * g.h);
  for (const i of painted) mine[i] = 1;
  const { labels, sizes } = components(W, g.h, (i) => mine[i] === 1);
  let main = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
  for (const i of painted) {
    if (labels[i] === main) {
      g.tiles[i].kind = 'floor';
      isl.tiles.push(i);
    } else owner[i] = -1;
  }
}

/**
 * A 1-wide bridge between two platform edge tiles: stepped-straight or with one bend, whichever
 * keeps clear of other bridges and platforms. Optional (circuit) bridges that cannot keep clear
 * are skipped, so bridges never run side by side and read as one wide walkway.
 */
function carveBridge(ctx: GenContext, owner: Int32Array, e: { a: number; b: number; from: number; to: number }, required: boolean): void {
  const { g, rng } = ctx;
  const W = g.w;
  const ax = e.from % W;
  const ay = (e.from - ax) / W;
  const bx = e.to % W;
  const by = (e.to - bx) / W;
  const bend = (cx: number, cy: number) => [...line4(ax, ay, cx, cy), ...line4(cx, cy, bx, by).slice(1)];
  const options = ax === bx || ay === by ? [line4(ax, ay, bx, by)] : [line4(ax, ay, bx, by), bend(bx, ay), bend(ax, by)];
  // preference order varies; the first option with the fewest conflicts wins
  shuffle(options, rng);
  const conflicts = (path: { x: number; y: number }[]) => {
    const mine = new Set(path.map((p) => p.y * W + p.x));
    let n = 0;
    for (const p of path) {
      if (g.passable(p.x, p.y)) continue; // already floor (an endpoint or a crossing)
      for (const [dx, dy] of RING8) {
        const i = (p.y + dy) * W + p.x + dx;
        if (mine.has(i) || !g.passable(p.x + dx, p.y + dy)) continue;
        const o = owner[i];
        if (o === -1 || (o !== e.a && o !== e.b)) n++;
      }
    }
    return n;
  };
  let best = options[0];
  let bestN = conflicts(best);
  for (const opt of options.slice(1)) {
    const n = conflicts(opt);
    if (n < bestN) {
      best = opt;
      bestN = n;
    }
  }
  if (bestN > 0 && !required) return;
  for (const p of best) if (g.inInterior(p.x, p.y) && !g.passable(p.x, p.y)) g.set(p.x, p.y, 'floor', null);
}
