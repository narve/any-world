/**
 * Post-processing shared by all generators: border closing, connectivity repair, wall/void
 * shaping, region bookkeeping, start/exit selection and lamp placement.
 */
import type { AreaMap, Pos, Rng, TileKind } from '../types';
import {
  DIRS4,
  Grid,
  PASSABLE_KINDS,
  RING8,
  bfsDistances,
  clamp,
  components,
  dijkstraPath,
  shuffle,
} from './grid';

/** Closed border: anything passable (or water) on the outer ring becomes wall. */
export function closeBorder(g: Grid): void {
  for (let x = 0; x < g.w; x++) {
    for (const y of [0, g.h - 1]) if (g.kind(x, y) !== 'void') g.set(x, y, 'wall', null);
  }
  for (let y = 0; y < g.h; y++) {
    for (const x of [0, g.w - 1]) if (g.kind(x, y) !== 'void') g.set(x, y, 'wall', null);
  }
}

/** True when a wall tile sits between passable tiles on opposite sides (a natural door spot). */
function isDoorway(g: Grid, x: number, y: number): boolean {
  const ew = g.passable(x - 1, y) && g.passable(x + 1, y) && !g.passable(x, y - 1) && !g.passable(x, y + 1);
  const ns = g.passable(x, y - 1) && g.passable(x, y + 1) && !g.passable(x - 1, y) && !g.passable(x + 1, y);
  return ew || ns;
}

/**
 * Joins every passable component to the largest one by carving the cheapest tunnel.
 * Components smaller than `dropBelow` are filled in instead.
 */
export function connectAll(g: Grid, opts: { dropBelow?: number; wallCost?: number; voidCost?: number; doors?: boolean } = {}): void {
  const dropBelow = opts.dropBelow ?? 0;
  const wallCost = opts.wallCost ?? 3;
  const voidCost = opts.voidCost ?? 5;
  for (let iter = 0; iter < 400; iter++) {
    const { labels, sizes } = components(g.w, g.h, (i) => PASSABLE_KINDS.has(g.tiles[i].kind));
    if (sizes.length <= 1) return;
    let main = 0;
    for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
    // drop tiny pockets
    let dropped = false;
    if (dropBelow > 0) {
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        if (l !== -1 && l !== main && sizes[l] < dropBelow) {
          g.tiles[i].kind = 'wall';
          delete g.tiles[i].region;
          dropped = true;
        }
      }
      if (dropped) continue;
    }
    const sources: number[] = [];
    for (let i = 0; i < labels.length; i++) if (labels[i] === main) sources.push(i);
    const path = dijkstraPath(
      g.w,
      g.h,
      sources,
      (i) => labels[i] !== -1 && labels[i] !== main,
      (i) => {
        const x = i % g.w;
        const y = (i - x) / g.w;
        if (g.isBorder(x, y)) return Infinity;
        const k = g.tiles[i].kind;
        if (PASSABLE_KINDS.has(k)) return 1;
        if (k === 'void') return voidCost;
        return wallCost;
      },
    );
    if (!path) {
      // unreachable (should not happen with a closed border); fill the smallest stray component
      let worst = -1;
      for (let c = 0; c < sizes.length; c++) if (c !== main && (worst === -1 || sizes[c] < sizes[worst])) worst = c;
      for (let i = 0; i < labels.length; i++) if (labels[i] === worst) g.tiles[i].kind = 'wall';
      continue;
    }
    const carved: number[] = [];
    for (const i of path) {
      const k = g.tiles[i].kind;
      if (!PASSABLE_KINDS.has(k)) {
        carved.push(i);
        g.tiles[i].kind = 'floor';
        delete g.tiles[i].region;
      }
    }
    // a single carved wall tile between two spaces reads best as a door
    for (const i of carved) {
      const x = i % g.w;
      const y = (i - x) / g.w;
      if (opts.doors !== false && carved.length <= 2 && isDoorway(g, x, y)) g.tiles[i].kind = 'door';
    }
  }
}

/**
 * Fills corridor spurs that lead nowhere: a passable tile with a single passable neighbour (8-way)
 * is a tip; tips are filled one layer at a time for up to `maxDepth` layers. Rooms are never
 * touched (their tiles have several neighbours) and the map stays connected (a tip is a leaf).
 */
export function pruneSpurs(g: Grid, maxDepth: number): void {
  for (let layer = 0; layer < maxDepth; layer++) {
    const tips: number[] = [];
    for (let y = 1; y < g.h - 1; y++)
      for (let x = 1; x < g.w - 1; x++) {
        if (!g.passable(x, y)) continue;
        let n = 0;
        for (const [dx, dy] of RING8) if (g.passable(x + dx, y + dy)) n++;
        if (n <= 1) tips.push(g.idx(x, y));
      }
    if (!tips.length) return;
    for (const i of tips) {
      g.tiles[i].kind = 'wall';
      delete g.tiles[i].region;
    }
  }
}

/**
 * Cuts up to `count` shortcuts through thin walls (1–2 tiles) where the walk around is longest,
 * turning dead-end rooms and long backtracks into loops (docs/playtest/FABLE-GAMEPLAY-REVIEW.md
 * §3.4). A shortcut is only cut when it saves at least `minSaving` steps. Single-tile cuts between
 * walls become doors when `doors` is set.
 */
export function addShortcuts(g: Grid, rng: Rng, count: number, opts: { minSaving?: number; doors?: boolean } = {}): void {
  if (count <= 0) return;
  const minSaving = opts.minSaving ?? 14;
  const pass = (i: number) => PASSABLE_KINDS.has(g.tiles[i].kind);
  const solid = (x: number, y: number) => g.inInterior(x, y) && g.kind(x, y) === 'wall';
  interface Cut {
    a: number;
    b: number;
    tiles: number[];
  }
  const cuts: Cut[] = [];
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      if (!solid(x, y)) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        // the cut runs along (dx,dy) and is walled on both sides, so it reads as a gap, not a hole
        const side = (cx: number, cy: number) => solid(cx + dy, cy + dx) && solid(cx - dy, cy - dx);
        if (!g.passable(x - dx, y - dy) || !side(x, y)) continue;
        if (g.passable(x + dx, y + dy)) cuts.push({ a: g.idx(x - dx, y - dy), b: g.idx(x + dx, y + dy), tiles: [g.idx(x, y)] });
        else if (solid(x + dx, y + dy) && side(x + dx, y + dy) && g.passable(x + 2 * dx, y + 2 * dy))
          cuts.push({ a: g.idx(x - dx, y - dy), b: g.idx(x + 2 * dx, y + 2 * dy), tiles: [g.idx(x, y), g.idx(x + dx, y + dy)] });
      }
    }
  if (!cuts.length) return;
  shuffle(cuts, rng);
  // walking distance a → b (4-way) over a passability snapshot, stopping as soon as b is reached
  const open = new Uint8Array(g.w * g.h);
  for (let i = 0; i < open.length; i++) open[i] = pass(i) ? 1 : 0;
  const dist = new Int32Array(g.w * g.h);
  const queue = new Int32Array(g.w * g.h);
  const walk = (a: number, b: number): number => {
    dist.fill(-1);
    dist[a] = 0;
    queue[0] = a;
    for (let head = 0, tail = 1; head < tail; head++) {
      const c = queue[head];
      if (c === b) return dist[c];
      for (const n of [c - 1, c + 1, c - g.w, c + g.w]) {
        if (open[n] && dist[n] === -1) {
          dist[n] = dist[c] + 1;
          queue[tail++] = n;
        }
      }
    }
    return -1;
  };
  const saving = (c: Cut) => {
    const d = walk(c.a, c.b);
    return d < 0 ? -1 : d - (c.tiles.length + 1);
  };
  // lazy greedy: a cut only ever shrinks the others' savings, so a stale value is an upper bound
  // and only the front of the list needs re-measuring after each cut
  const best = cuts.slice(0, 80).map((c) => ({ c, s: saving(c) }));
  for (let made = 0; made < count; ) {
    best.sort((p, q) => q.s - p.s);
    const top = best[0];
    if (!top || top.s < minSaving) return;
    const fresh = top.c.tiles.some(pass) ? -1 : saving(top.c);
    if (fresh < top.s) {
      top.s = fresh;
      continue;
    }
    best.shift();
    for (const i of top.c.tiles) {
      g.tiles[i].kind = 'floor';
      delete g.tiles[i].region;
      open[i] = 1;
    }
    if (opts.doors && top.c.tiles.length === 1) {
      const i = top.c.tiles[0];
      const x = i % g.w;
      if (isDoorway(g, x, (i - x) / g.w)) g.tiles[i].kind = 'door';
    }
    made++;
  }
}

/** Void tiles touching (8-way) a passable tile become wall. */
export function wallify(g: Grid): void {
  const toWall: number[] = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      if (g.kind(x, y) !== 'void') continue;
      for (const [dx, dy] of RING8) {
        const k = g.kind(x + dx, y + dy);
        if (PASSABLE_KINDS.has(k) || k === 'water') {
          toWall.push(g.idx(x, y));
          break;
        }
      }
    }
  for (const i of toWall) g.tiles[i].kind = 'wall';
}

/**
 * Solid walls that touch no open tile and connect to the map edge are "outside the shape"
 * and become void. Enclosed solid blocks inside the shape remain wall.
 */
export function voidOutside(g: Grid): void {
  const n = g.w * g.h;
  const solid = new Uint8Array(n); // 1 = wall/void with no open neighbour
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const k = g.kind(x, y);
      if (k !== 'wall' && k !== 'void') continue;
      let open = false;
      for (const [dx, dy] of RING8) {
        const nk = g.kind(x + dx, y + dy);
        if (PASSABLE_KINDS.has(nk) || nk === 'water') {
          open = true;
          break;
        }
      }
      if (!open) solid[g.idx(x, y)] = 1;
    }
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      if (!g.isBorder(x, y)) continue;
      const i = g.idx(x, y);
      if (solid[i] && !seen[i]) {
        seen[i] = 1;
        stack.push(i);
      }
    }
  while (stack.length) {
    const c = stack.pop()!;
    const cx = c % g.w;
    const cy = (c - cx) / g.w;
    for (const [dx, dy] of RING8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!g.inBounds(nx, ny)) continue;
      const ni = g.idx(nx, ny);
      if (solid[ni] && !seen[ni]) {
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (seen[i]) {
      g.tiles[i].kind = 'void';
      delete g.tiles[i].region;
      delete g.tiles[i].lamp;
    }
  }
}

/**
 * Partitions passable tiles that have no region yet into roughly even zones
 * (farthest-point seeds + geodesic growth). Used for caves, fields and mazes.
 */
export function fillRegionsVoronoi(g: Grid, rng: Rng, tilesPerRegion = 90): void {
  const free: number[] = [];
  for (let i = 0; i < g.tiles.length; i++) {
    const t = g.tiles[i];
    if (t.kind === 'floor' && t.region === undefined) free.push(i);
  }
  if (free.length === 0) return;
  const k = clamp(Math.round(free.length / tilesPerRegion), 1, 16);
  const seeds: number[] = [free[rng.int(0, free.length - 1)]];
  const minD = new Float64Array(free.length).fill(Infinity);
  while (seeds.length < k) {
    const s = seeds[seeds.length - 1];
    const sx = s % g.w;
    const sy = (s - sx) / g.w;
    let best = -1;
    let bestD = -1;
    for (let j = 0; j < free.length; j++) {
      const i = free[j];
      const x = i % g.w;
      const y = (i - x) / g.w;
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < minD[j]) minD[j] = d;
      if (minD[j] > bestD) {
        bestD = minD[j];
        best = i;
      }
    }
    if (best === -1 || bestD <= 4) break;
    seeds.push(best);
  }
  // simultaneous BFS growth over unassigned floor tiles
  const owner = new Int32Array(g.tiles.length).fill(-1);
  const isFree = (i: number) => g.tiles[i].kind === 'floor' && g.tiles[i].region === undefined;
  let frontier: number[] = [];
  for (const s of seeds) {
    const r = g.newRegion();
    owner[s] = r;
    frontier.push(s);
  }
  while (frontier.length) {
    const next: number[] = [];
    for (const c of frontier) {
      const cx = c % g.w;
      const cy = (c - cx) / g.w;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!g.inBounds(nx, ny)) continue;
        const n = g.idx(nx, ny);
        if (owner[n] === -1 && isFree(n)) {
          owner[n] = owner[c];
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  for (let i = 0; i < owner.length; i++) if (owner[i] !== -1) g.tiles[i].region = owner[i];
}

/** Region table from tile tags; ids are compacted to 0..n-1 in id order. */
export function buildRegions(g: Grid, names?: ReadonlyMap<number, string>): AreaMap['regions'] {
  const ROOMY: ReadonlySet<TileKind> = new Set<TileKind>(['floor', 'start', 'transition']);
  const sums = new Map<number, { sx: number; sy: number; n: number; tiles: number[] }>();
  for (let i = 0; i < g.tiles.length; i++) {
    const t = g.tiles[i];
    if (t.region === undefined) continue;
    if (!ROOMY.has(t.kind)) {
      delete t.region;
      continue;
    }
    const x = i % g.w;
    const y = (i - x) / g.w;
    let s = sums.get(t.region);
    if (!s) {
      s = { sx: 0, sy: 0, n: 0, tiles: [] };
      sums.set(t.region, s);
    }
    s.sx += x;
    s.sy += y;
    s.n++;
    s.tiles.push(i);
  }
  const ids = [...sums.keys()].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  const regions: AreaMap['regions'] = [];
  ids.forEach((old, k) => {
    remap.set(old, k);
    const s = sums.get(old)!;
    const mx = s.sx / s.n;
    const my = s.sy / s.n;
    let best = s.tiles[0];
    let bestD = Infinity;
    for (const i of s.tiles) {
      const x = i % g.w;
      const y = (i - x) / g.w;
      const d = (x - mx) * (x - mx) + (y - my) * (y - my);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const cx = best % g.w;
    const name = names?.get(old);
    const region: AreaMap['regions'][number] = { id: k, centre: { x: cx, y: (best - cx) / g.w }, size: s.n };
    if (name) region.name = name;
    regions.push(region);
  });
  for (const t of g.tiles) if (t.region !== undefined) t.region = remap.get(t.region);
  return regions;
}

function dist(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Chooses distant, connected start and exit floor tiles. */
export function chooseStartExit(g: Grid, rng: Rng): { start: Pos; exit: Pos } {
  const cands: Pos[] = [];
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) if (g.kind(x, y) === 'floor') cands.push({ x, y });
  if (cands.length < 2) throw new Error('mapgen: fewer than two floor tiles');
  // extremes along 8 directions, rotated by a random angle for variety
  const rot = rng.next() * (Math.PI / 4);
  const ext: Pos[] = [];
  for (let k = 0; k < 8; k++) {
    const a = rot + (k * Math.PI) / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let best = cands[0];
    let bestV = -Infinity;
    for (const c of cands) {
      const v = c.x * ux + c.y * uy;
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (!ext.some((e) => e.x === best.x && e.y === best.y)) ext.push(best);
  }
  if (ext.length < 2) {
    ext.length = 0;
    ext.push(cands[0], cands[cands.length - 1]);
  }
  const pairs: { a: Pos; b: Pos; d: number }[] = [];
  for (let i = 0; i < ext.length; i++)
    for (let j = i + 1; j < ext.length; j++) pairs.push({ a: ext[i], b: ext[j], d: dist(ext[i], ext[j]) });
  const maxD = Math.max(...pairs.map((p) => p.d));
  const good = pairs.filter((p) => p.d >= maxD * 0.88);
  const pick = good[rng.int(0, good.length - 1)];
  let start = pick.a;
  let exit = pick.b;
  const diag = Math.hypot(g.w, g.h);
  const need = Math.min(0.4 * diag, pick.d * 0.9);
  // jitter endpoints slightly so maps with similar shapes vary
  const jitter = (p: Pos, other: Pos): Pos => {
    const near = cands.filter((c) => Math.abs(c.x - p.x) <= 2 && Math.abs(c.y - p.y) <= 2 && dist(c, other) >= need);
    return near.length ? near[rng.int(0, near.length - 1)] : p;
  };
  start = jitter(start, exit);
  exit = jitter(exit, start);
  if (rng.chance(0.5)) [start, exit] = [exit, start];
  return { start, exit };
}

/**
 * Lamps on walls bordering open floor (or, where walls are scarce, on floor edges),
 * spaced apart. `frequency` 0..1 maps to roughly one lamp per 6/frequency open tiles.
 */
export function placeLamps(g: Grid, frequency: number, rng: Rng): void {
  if (!(frequency > 0)) return;
  const open = g.countPassable();
  const target = clamp(Math.round((frequency * open) / 6), 1, 60);
  const wallCands: number[] = [];
  const edgeCands: number[] = [];
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const k = g.kind(x, y);
      if (k === 'wall') {
        let touches = false;
        for (const [dx, dy] of DIRS4) if (g.kind(x + dx, y + dy) === 'floor') touches = true;
        if (touches) wallCands.push(g.idx(x, y));
      } else if (k === 'floor') {
        let edge = false;
        for (const [dx, dy] of RING8) {
          const nk = g.kind(x + dx, y + dy);
          if (!PASSABLE_KINDS.has(nk)) edge = true;
        }
        if (edge) edgeCands.push(g.idx(x, y));
      }
    }
  shuffle(wallCands, rng);
  shuffle(edgeCands, rng);
  const placed: Pos[] = [];
  const spacing = clamp(Math.round(4 - frequency * 3), 2, 4);
  const tryPlace = (list: number[]) => {
    for (const i of list) {
      if (placed.length >= target) return;
      const x = i % g.w;
      const y = (i - x) / g.w;
      if (placed.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < spacing)) continue;
      g.tiles[i].lamp = true;
      placed.push({ x, y });
    }
  };
  tryPlace(wallCands);
  if (placed.length < target) tryPlace(edgeCands);
}

/** Runs all shared post-processing and returns the finished map. */
export function finalize(
  g: Grid,
  rng: Rng,
  opts: {
    lampFrequency: number;
    dropBelow?: number;
    voronoi?: number;
    doors?: boolean;
    /** keep void directly next to open tiles (no wall rim) — floating layouts */
    openEdges?: boolean;
    /** generator region id → structural name */
    regionNames?: ReadonlyMap<number, string>;
    /** layers of dead-end corridor spurs to fill (pruneSpurs) */
    pruneSpurs?: number;
    /** loops to cut through thin walls (addShortcuts) */
    shortcuts?: number;
  },
): AreaMap {
  closeBorder(g);
  connectAll(g, { dropBelow: opts.dropBelow, doors: opts.doors });
  if (!opts.openEdges) wallify(g);
  closeBorder(g);
  voidOutside(g);
  if (opts.pruneSpurs) pruneSpurs(g, opts.pruneSpurs);
  if (opts.shortcuts && !opts.openEdges) addShortcuts(g, rng, opts.shortcuts, { doors: opts.doors });
  if (opts.voronoi) fillRegionsVoronoi(g, rng, opts.voronoi);
  const { start, exit } = chooseStartExit(g, rng);
  g.set(start.x, start.y, 'start');
  g.set(exit.x, exit.y, 'transition');
  const regions = buildRegions(g, opts.regionNames);
  placeLamps(g, opts.lampFrequency, rng);
  return { width: g.w, height: g.h, tiles: g.tiles, start, exit, regions };
}
