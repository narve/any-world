/**
 * Organic: smooth, lumpy chambers joined by curving tubes — the inside of a creature, a coral
 * reef, a hive or a dream. Shapes come from a metaball field (compact-support kernels summed
 * over chamber lobes and tube segments, so junctions blend into fleshy necks) perturbed by
 * value noise; nothing is rectangular. Chambers may hold nodules (solid lumps), pools of fluid
 * ('water') and membranes (a wall across the chamber with one opening).
 *
 * Knobs (plan.params; all optional, out-of-range values are clamped):
 *   chambers     2..16   number of chambers, alias blobs (default 5 / 7 / 10 for small / medium / large)
 *   chamberSize  0..1    average chamber size (0.5)
 *   tubeWidth    1..4    walkable width of the tubes in tiles (1.6)
 *   curl         0..1    how much the tubes bend (0.5)
 *   loops        0..1    share of extra tubes that form circuits (0.25)
 *   wobble       0..1    how ragged / bumpy the walls are (0.4)
 *   nodules      0..1    chance per chamber of a solid lump inside it (0.35)
 *   fluid        0..1    chance per chamber of a pool of fluid (0.25)
 *   membranes    0..1    chance that a big chamber is split by a membrane with one gap (0.3)
 *
 * Region names: "chamber", "great chamber" (largest), "small chamber", "chamber lobe" (a
 * membrane-split half). Tubes carry no region.
 */
import { bySize, type GenContext } from '../context';
import { RING8, canBlockLocally, clamp } from '../grid';
import { segmentDistance, spanningTree, valueNoise, type WeightedEdge } from '../shapes';

interface Lobe {
  x: number;
  y: number;
  r: number;
}
interface Chamber {
  x: number;
  y: number;
  r: number;
  lobes: Lobe[];
}
interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** compact-support metaball kernel: 1 at the centre, 0 at distance >= r */
function kernel(d: number, r: number): number {
  if (d >= r) return 0;
  const t = 1 - (d * d) / (r * r);
  return t * t;
}
const THRESHOLD = 0.3;

export function genOrganic(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const W = g.w;
  const H = g.h;
  const count = Math.round(ctx.param(['chambers', 'chamberCount', 'blobs', 'roomCount'], bySize(size, 5, 7, 10) + rng.int(-1, 1), 2, 16));
  const sizeScale = ctx.param(['chamberSize', 'size'], 0.5, 0, 1);
  const tubeWidth = ctx.param(['tubeWidth', 'corridorWidth'], 1.6, 1, 4);
  const curl = ctx.param(['curl', 'curviness'], 0.5, 0, 1);
  const loops = ctx.param('loops', 0.25, 0, 1);
  const wobble = ctx.param(['wobble', 'roughness'], 0.4, 0, 1);
  const noduleChance = ctx.param('nodules', 0.35, 0, 1);
  const fluidChance = ctx.param(['fluid', 'pools'], 0.25, 0, 1);
  const membraneChance = ctx.param('membranes', 0.3, 0, 1);

  // ---- chambers ---------------------------------------------------------------------------
  // a kernel of radius R yields floor out to R * sqrt(1 - sqrt(T)) ≈ 0.67 R
  const reachFactor = Math.sqrt(1 - Math.sqrt(THRESHOLD));
  const interior = (W - 4) * (H - 4);
  const meanFloorR = clamp(Math.sqrt((interior * (0.22 + sizeScale * 0.16)) / count / Math.PI), 2, Math.min(W, H) / 3.4);
  const chambers: Chamber[] = [];
  for (let k = 0; k < count; k++) {
    let fr = meanFloorR * (0.65 + rng.next() * 0.7);
    let gap = 2;
    let placed: { x: number; y: number } | null = null;
    // best of a few valid candidates (farthest from the others) spreads chambers over the map
    let bestScore = -1;
    let valid = 0;
    for (let attempt = 0; attempt < 100 && valid < 5; attempt++) {
      if (attempt > 0 && attempt % 20 === 0 && valid === 0) {
        fr = Math.max(1.8, fr * 0.85);
        gap = Math.max(0, gap - 1);
      }
      const m = Math.min(fr + 1.5, Math.min(W, H) / 2 - 2);
      const x = m + rng.next() * (W - 1 - 2 * m);
      const y = m + rng.next() * (H - 1 - 2 * m);
      let nearest = Infinity;
      for (const c of chambers) nearest = Math.min(nearest, Math.hypot(c.x - x, c.y - y) - (c.r + fr) * 0.9 - gap);
      if (nearest < 0) continue;
      valid++;
      const score = Math.min(nearest, 1e6);
      if (score > bestScore) {
        bestScore = score;
        placed = { x, y };
      }
    }
    if (!placed) continue;
    const { x, y } = placed;
    const R = fr / reachFactor;
    const lobes: Lobe[] = [{ x, y, r: R }];
    // 1-3 satellite lobes make the chamber lumpy rather than round
    const extra = rng.int(1, 3);
    for (let l = 0; l < extra; l++) {
      const a = rng.next() * Math.PI * 2;
      const d = fr * (0.35 + rng.next() * 0.45);
      const lx = clamp(x + Math.cos(a) * d, 2, W - 3);
      const ly = clamp(y + Math.sin(a) * d, 2, H - 3);
      lobes.push({ x: lx, y: ly, r: R * (0.45 + rng.next() * 0.35) });
    }
    chambers.push({ x, y, r: fr, lobes });
  }
  if (chambers.length < 2) throw new Error('organic: could not place chambers');

  // ---- tubes: spanning tree + a few loops, each a bent curve ------------------------------
  const edges: WeightedEdge[] = [];
  for (let a = 0; a < chambers.length; a++)
    for (let b = a + 1; b < chambers.length; b++) {
      const d = Math.hypot(chambers[a].x - chambers[b].x, chambers[a].y - chambers[b].y);
      edges.push({ a, b, w: d - chambers[a].r - chambers[b].r });
    }
  const [tree, rest] = spanningTree(chambers.length, edges);
  const links = [...tree];
  const maxExtra = Math.ceil(chambers.length * loops * 0.6);
  for (const e of rest) {
    if (links.length - tree.length >= maxExtra) break;
    if (rng.chance(loops)) links.push(e);
  }
  const tubeR = (tubeWidth / 2 + 0.35) / reachFactor;
  const tubes: Segment[][] = links.map((e) => {
    const A = chambers[e.a];
    const B = chambers[e.b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    // never quite straight: at least a gentle arc unless curl is 0
    const bend = (rng.chance(0.5) ? 1 : -1) * (0.25 + rng.next() * 0.75) * curl * 0.45 * len;
    const t = 0.3 + rng.next() * 0.4;
    const px = clamp(A.x + dx * t + (-dy / len) * bend, 2, W - 3);
    const py = clamp(A.y + dy * t + (dx / len) * bend, 2, H - 3);
    // quadratic Bézier sampled into segments
    const n = Math.max(3, Math.ceil(len / 2.5));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      pts.push({
        x: (1 - s) * (1 - s) * A.x + 2 * (1 - s) * s * px + s * s * B.x,
        y: (1 - s) * (1 - s) * A.y + 2 * (1 - s) * s * py + s * s * B.y,
      });
    }
    const segs: Segment[] = [];
    for (let i = 0; i < n; i++) segs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y });
    return segs;
  });

  // ---- field ------------------------------------------------------------------------------
  const noise = valueNoise(rng, W, H, 4);
  const fine = valueNoise(rng, W, H, 2);
  const regionOf = chambers.map(() => g.newRegion());
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      let best = 0;
      let bestC = -1;
      let total = 0;
      for (let c = 0; c < chambers.length; c++) {
        let f = 0;
        for (const l of chambers[c].lobes) f += kernel(Math.hypot(x - l.x, y - l.y), l.r);
        total += f;
        if (f > best) {
          best = f;
          bestC = c;
        }
      }
      let tube = 0;
      // tubes swell and pinch along their length
      const localR = tubeR * (1 + 0.35 * wobble * noise(x + 17, y + 11));
      for (const segs of tubes) {
        let m = 0;
        for (const s of segs) m = Math.max(m, kernel(segmentDistance(x, y, s.ax, s.ay, s.bx, s.by), localR));
        tube += m;
      }
      const field = total + tube + wobble * (0.16 * noise(x, y) + 0.08 * fine(x, y));
      if (field < THRESHOLD) continue;
      // chamber tiles belong to the dominant chamber; the rest is tube
      if (bestC >= 0 && best >= tube && best >= THRESHOLD * 0.5) g.set(x, y, 'floor', regionOf[bestC]);
      else g.set(x, y, 'floor');
    }

  // ---- membranes, nodules and fluid -------------------------------------------------------
  const passable = (x: number, y: number) => g.passable(x, y);
  const tilesOf = (region: number) => {
    const out: number[] = [];
    for (let i = 0; i < g.tiles.length; i++) if (g.tiles[i].region === region && g.tiles[i].kind === 'floor') out.push(i);
    return out;
  };
  const sizes = regionOf.map((r) => tilesOf(r).length);
  const largest = sizes.indexOf(Math.max(...sizes));
  const meanSize = sizes.reduce((s, n) => s + n, 0) / sizes.length;
  chambers.forEach((ch, c) => {
    const region = regionOf[c];
    ctx.regionNames.set(region, c === largest ? 'great chamber' : sizes[c] < meanSize * 0.6 ? 'small chamber' : 'chamber');
    if (sizes[c] >= 45 && rng.chance(membraneChance)) splitByMembrane(ctx, ch, region, tilesOf(region));
    if (sizes[c] >= 24 && rng.chance(noduleChance)) {
      const inner = tilesOf(region).filter((i) => {
        const x = i % W;
        const y = (i - x) / W;
        return RING8.every(([dx, dy]) => g.passable(x + dx, y + dy));
      });
      if (inner.length) {
        const c0 = rng.pick(inner);
        const nx = c0 % W;
        const ny = (c0 - nx) / W;
        const r = 0.8 + rng.next() * Math.min(1.6, Math.sqrt(sizes[c]) / 6);
        for (let y = Math.floor(ny - r); y <= Math.ceil(ny + r); y++)
          for (let x = Math.floor(nx - r); x <= Math.ceil(nx + r); x++)
            if (Math.hypot(x - nx, y - ny) <= r && g.kind(x, y) === 'floor' && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
      }
    }
    if (sizes[c] >= 20 && rng.chance(fluidChance)) {
      const own = tilesOf(region);
      if (own.length) {
        let i = rng.pick(own);
        const n = rng.int(4, 10);
        for (let k = 0; k < n * 3; k++) {
          const x = i % W;
          const y = (i - x) / W;
          if (g.tiles[i].region === region && g.kind(x, y) === 'floor' && canBlockLocally(passable, x, y)) g.set(x, y, 'water', null);
          const [dx, dy] = rng.pick(RING8);
          if (g.inInterior(x + dx, y + dy)) i = (y + dy) * W + x + dx;
        }
      }
    }
  });

  ctx.carveDoors = false;
  ctx.dropBelow = 6;
  ctx.voronoi = 0;
}

/** A wall across a chamber through its centre with a single opening; halves become regions. */
function splitByMembrane(ctx: GenContext, ch: Chamber, region: number, tiles: number[]): void {
  const { g, rng } = ctx;
  const W = g.w;
  const a = rng.next() * Math.PI;
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const gapAt = (rng.next() * 2 - 1) * ch.r * 0.4;
  const other = g.newRegion();
  for (const i of tiles) {
    const x = i % W;
    const y = (i - x) / W;
    const side = (x - ch.x) * nx + (y - ch.y) * ny; // signed distance to the membrane line
    const along = -(x - ch.x) * ny + (y - ch.y) * nx;
    if (Math.abs(side) < 0.55 && Math.abs(along - gapAt) > 1.1) g.set(x, y, 'wall', null);
    else if (side > 0) g.tiles[i].region = other;
  }
  ctx.regionNames.set(region, 'chamber lobe');
  ctx.regionNames.set(other, 'chamber lobe');
}
