/**
 * Geometric: abstract symmetric layouts — concentric rings with spokes, tessellations
 * (hexagons, triangles, a diagonal diamond lattice) and kaleidoscopic facets (a Voronoi
 * pattern mirrored around the centre). The plane is partitioned into cells, every cell
 * boundary becomes a 1-tile wall (2 tiles on diagonals, so nothing leaks diagonally), and
 * openings are cut in symmetric sets until all cells are connected. Fits abstract art, crystal
 * lattices, ritual geometry, data-space or any world that should look designed, not built.
 *
 * Knobs (plan.params; all optional, out-of-range values are clamped):
 *   variant   0..4   0 rings, 1 hexagons, 2 triangles, 3 diamond lattice, 4 kaleidoscope (random;
 *                    without it, tessellation 1..3 picks variant 1..3, rings >= 2 picks rings and
 *                    rings 0 picks anything but rings)
 *   symmetry  1..4   1 none, 2 left-right mirror, 3 point (180° rotation), 4 both mirrors
 *                    (random, mostly 4; higher values mean 4)
 *   rings     2..8   number of rings incl. the core (variant 0; default 3 / 4 / 5 by size)
 *   spokes    0..12  radial walls splitting each ring into sectors (variant 0; even; random)
 *   shape     0..3   ring shape: 0 circle, 1 square, 2 diamond, 3 octagon (variant 0; random)
 *   cellSize  4..12  tessellation cell size in tiles (variants 1-3; 6 / 7 / 8 by size, +1 for
 *                    diamonds; hexagons and triangles use at least 5, diamonds at least 6)
 *   facets    3..14  seed points per symmetric sector (variant 4; 4 / 5 / 7 by size)
 *   frame     0..3   outline for variants 1-4: 0 full rectangle, 1 ellipse, 2 diamond, 3 octagon
 *   loops     0..1   chance of extra openings once everything is connected (0.3)
 *   pillars   0..1   chance that a symmetric set of large cells gets a central pillar (0.3)
 *   doors     0..1   share of single-tile openings that are doors (0)
 *
 * Region names: "core", "ring 1".."ring N" / "outer ring" (rings, with " sector" when spokes
 * split them), "hexagonal cell", "triangular cell", "diamond cell", "facet"; the cell at the
 * very centre is prefixed "central".
 */
import { bySize, type GenContext } from '../context';
import { DIRS4, RING8, canBlockLocally, clamp, shuffle } from '../grid';
import { DisjointSet } from '../shapes';

type Xform = (x: number, y: number) => [number, number];

interface Opening {
  tiles: number[];
  a: number;
  b: number;
}

export function genGeometric(ctx: GenContext): void {
  const { g, rng, size } = ctx;
  const W = g.w;
  const H = g.h;
  // prompt writers often say what they want instead of naming a variant
  const ringsAsked = ctx.param('rings', -1, -1, 8);
  const tessellation = Math.round(ctx.param(['tessellation', 'tiling'], 0, 0, 3));
  const fallbackVariant = tessellation > 0 ? tessellation : ringsAsked >= 2 ? 0 : ringsAsked === 0 ? rng.int(1, 4) : rng.int(0, 4);
  const variant = Math.round(ctx.param(['variant', 'pattern'], fallbackVariant, 0, 4));
  const symmetry = Math.round(ctx.param('symmetry', rng.pick([2, 3, 4, 4, 4]), 1, 4));
  const loops = ctx.param('loops', 0.3, 0, 1);
  const pillarChance = ctx.param('pillars', 0.3, 0, 1);
  const doorShare = ctx.param('doors', 0, 0, 1);
  const frame = Math.round(ctx.param('frame', rng.pick([0, 0, 1, 2, 3]), 0, 3));

  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const ex = (W - 3) / 2;
  const ey = (H - 3) / 2;

  // ---- symmetry group ---------------------------------------------------------------------
  const id: Xform = (x, y) => [x, y];
  const mx: Xform = (x, y) => [W - 1 - x, y];
  const my: Xform = (x, y) => [x, H - 1 - y];
  const mxy: Xform = (x, y) => [W - 1 - x, H - 1 - y];
  const group: Xform[] = symmetry === 1 ? [id] : symmetry === 2 ? [id, mx] : symmetry === 3 ? [id, mxy] : [id, mx, my, mxy];

  // ---- partition into cells (raw string/number keys, -1 = outside the shape) ---------------
  const inFrame = (u: number, v: number): boolean => {
    const au = Math.abs(u);
    const av = Math.abs(v);
    if (frame === 1) return au * au + av * av <= 1.04;
    if (frame === 2) return au + av <= 1.08;
    if (frame === 3) return Math.max(au, av, (au + av) / 1.45) <= 1.0;
    return true;
  };
  let cellOf: (x: number, y: number) => string | null;
  let baseName = 'cell';
  const ringNames = new Map<string, string>();
  if (variant === 0) {
    const shape = Math.round(ctx.param('shape', rng.int(0, 3), 0, 3));
    const maxRings = Math.max(2, Math.floor(ey / 2.6));
    const rings = Math.round(clamp(ctx.param('rings', bySize(size, 3, 4, 5), 2, 8), 2, maxRings));
    let spokes = Math.round(ctx.param('spokes', rng.pick([0, 4, 4, 6, 8]), 0, 12) / 2) * 2;
    if (spokes === 2 && symmetry !== 1) spokes = 4;
    const offsets = Array.from({ length: rings }, () => (rng.chance(0.5) ? 0 : Math.PI / Math.max(1, spokes)));
    const metric = (u: number, v: number): number => {
      const au = Math.abs(u);
      const av = Math.abs(v);
      if (shape === 1) return Math.max(au, av);
      if (shape === 2) return au + av;
      if (shape === 3) return Math.max(au, av, (au + av) / 1.45);
      return Math.hypot(au, av);
    };
    // the core gets a slightly bigger share so it is a real space
    const edges = Array.from({ length: rings }, (_, k) => (k + 1.25) / (rings + 0.25));
    cellOf = (x, y) => {
      const u = (x - cx) / ex;
      const v = (y - cy) / ey;
      const r = metric(u, v);
      if (r > 1) return null;
      let ring = 0;
      while (ring < rings - 1 && r > edges[ring]) ring++;
      if (ring === 0 || spokes === 0) return `r${ring}`;
      let a = Math.atan2(v, u) + offsets[ring] + Math.PI * 4;
      a %= Math.PI * 2;
      return `r${ring}s${Math.floor((a / (Math.PI * 2)) * spokes) % spokes}`;
    };
    for (let k = 0; k < rings; k++) {
      const n = k === 0 ? 'core' : k === rings - 1 ? 'outer ring' : `ring ${k}`;
      ringNames.set(`r${k}`, k > 0 && spokes ? `${n} sector` : n);
    }
  } else if (variant === 4) {
    const facets = Math.round(ctx.param(['facets', 'cells'], bySize(size, 4, 5, 7), 3, 14));
    const metric = rng.pick(['euclid', 'euclid', 'manhattan', 'chebyshev'] as const);
    const seeds: [number, number][] = [];
    for (let k = 0; k < facets; k++) {
      let dx = (rng.next() * 2 - 1) * ex;
      let dy = (rng.next() * 2 - 1) * ey;
      if (symmetry !== 1) dx = Math.abs(dx);
      if (symmetry === 4) dy = Math.abs(dy);
      // images of the seed under the symmetry group (continuous coordinates)
      const imgs: [number, number][] = symmetry === 1 ? [[dx, dy]] : symmetry === 2 ? [[dx, dy], [-dx, dy]] : symmetry === 3 ? [[dx, dy], [-dx, -dy]] : [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]];
      seeds.push(...imgs);
    }
    // the Euclidean term breaks the many exact ties of the blocky metrics, so mirrored seeds
    // never compete for the same tile and the facets stay mirror-symmetric
    const dist = (ax: number, ay: number) =>
      metric === 'manhattan'
        ? Math.abs(ax) + Math.abs(ay) + 1e-3 * Math.hypot(ax, ay)
        : metric === 'chebyshev'
          ? Math.max(Math.abs(ax), Math.abs(ay)) + 1e-3 * Math.hypot(ax, ay)
          : Math.hypot(ax, ay);
    cellOf = (x, y) => {
      if (!inFrame((x - cx) / ex, (y - cy) / ey)) return null;
      let best = 0;
      let bestD = Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const d = dist(x - cx - seeds[s][0], y - cy - seeds[s][1]);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return `f${best}`;
    };
    baseName = 'facet';
  } else {
    // diagonal walls are two tiles thick, so diamonds need a little more room than hexagons
    // The tiny irrational stretch keeps lattice lines (and hexagon ties) off exact tile
    // coordinates, so the partition is exactly mirror-symmetric (floor(-q) = -1 - floor(q)
    // only holds when q is not an integer).
    const s = Math.max(variant === 3 ? 6 : 5, ctx.param('cellSize', bySize(size, 6, 7, 8) + (variant === 3 ? 1 : 0), 4, 12)) * (1 + Math.SQRT2 * 1e-4);
    if (variant === 1) {
      const rowH = s * 0.866;
      const J = Math.ceil(H / rowH) + 1;
      const I = Math.ceil(W / s) + 1;
      cellOf = (x, y) => {
        if (!inFrame((x - cx) / ex, (y - cy) / ey)) return null;
        const dx = x - cx;
        const dy = y - cy;
        const j0 = Math.round(dy / rowH);
        let best = '';
        let bestD = Infinity;
        for (let j = Math.max(-J, j0 - 1); j <= Math.min(J, j0 + 1); j++) {
          const off = (((j % 2) + 2) % 2) * 0.5;
          const i0 = Math.round(dx / s - off);
          for (let i = Math.max(-I, i0 - 1); i <= Math.min(I, i0 + 1); i++) {
            const d = Math.hypot(dx - (i + off) * s, dy - j * rowH);
            if (d < bestD) {
              bestD = d;
              best = `h${i},${j}`;
            }
          }
        }
        return best;
      };
      baseName = 'hexagonal cell';
    } else if (variant === 2) {
      const t = s * 1.5;
      cellOf = (x, y) => {
        if (!inFrame((x - cx) / ex, (y - cy) / ey)) return null;
        const dx = x - cx;
        const dy = y - cy;
        const a = Math.floor(dy / t);
        const b = Math.floor((0.866 * dx - 0.5 * dy) / t);
        const c = Math.floor((-0.866 * dx - 0.5 * dy) / t);
        return `t${a},${b},${c}`;
      };
      baseName = 'triangular cell';
    } else {
      cellOf = (x, y) => {
        if (!inFrame((x - cx) / ex, (y - cy) / ey)) return null;
        const dx = x - cx;
        const dy = y - cy;
        // half-cell offset: a diamond sits on the centre and the mirrors swap the two families
        return `d${Math.floor((dx + dy) / s + 0.5)},${Math.floor((dx - dy) / s + 0.5)}`;
      };
      baseName = 'diamond cell';
    }
  }

  // ---- compact cell ids + symmetric priority keys ------------------------------------------
  const N = W * H;
  const cell = new Int32Array(N).fill(-1);
  const raw: string[] = [];
  const ids = new Map<string, number>();
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const k = cellOf(x, y);
      if (k === null) continue;
      let c = ids.get(k);
      if (c === undefined) {
        c = raw.length;
        ids.set(k, c);
        raw.push(k);
      }
      cell[y * W + x] = c;
    }
  const key = new Float64Array(raw.length).fill(Infinity);
  for (let i = 0; i < N; i++) {
    const c = cell[i];
    if (c < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (const f of group) {
      const [gx, gy] = f(x, y);
      const gi = gy * W + gx;
      if (gi < key[c]) key[c] = gi;
    }
  }

  // ---- walls on cell boundaries (higher-priority cell gives up its edge; ties: both) -------
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = cell[i];
      if (c < 0) continue;
      let wall = false;
      for (const [dx, dy] of RING8) {
        const n = cell[(y + dy) * W + x + dx];
        if (n >= 0 && n !== c && key[n] <= key[c]) {
          wall = true;
          break;
        }
      }
      g.set(x, y, wall ? 'wall' : 'floor');
    }
  // remnants of clipped cells too small to be spaces become solid
  const floorCount = new Int32Array(raw.length);
  for (let i = 0; i < N; i++) if (cell[i] >= 0 && g.tiles[i].kind === 'floor') floorCount[cell[i]]++;
  for (let i = 0; i < N; i++) if (cell[i] >= 0 && g.tiles[i].kind === 'floor' && floorCount[cell[i]] < 4) g.tiles[i].kind = 'wall';
  const floorCell = (i: number) => (g.tiles[i].kind === 'floor' ? cell[i] : -1);

  // ---- openings ---------------------------------------------------------------------------
  const openings = new Map<string, Opening>();
  const addOpening = (tiles: number[], a: number, b: number) => {
    const t = [...tiles].sort((p, q) => p - q);
    const k = t.join(',');
    if (!openings.has(k)) openings.set(k, { tiles: t, a: Math.min(a, b), b: Math.max(a, b) });
  };
  const wallAt = (x: number, y: number) => g.inInterior(x, y) && g.kind(x, y) === 'wall' && cell[y * W + x] >= 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (!wallAt(x, y)) continue;
      const i = y * W + x;
      // single tile between opposite floors of different cells
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const a = floorCell((y - dy) * W + x - dx);
        const b = floorCell((y + dy) * W + x + dx);
        if (a >= 0 && b >= 0 && a !== b) addOpening([i], a, b);
      }
      // two tiles through a thick (diagonal) wall
      for (const [dx, dy] of DIRS4) {
        const a = floorCell((y + dy) * W + x + dx);
        if (a < 0) continue;
        for (const [ex2, ey2] of DIRS4) {
          const x2 = x + ex2;
          const y2 = y + ey2;
          if (!wallAt(x2, y2)) continue;
          // the second tile continues straight on, or turns; it must reach a different cell
          for (const [fx, fy] of DIRS4) {
            const b = floorCell((y2 + fy) * W + x2 + fx);
            if (b >= 0 && b !== a && (fx !== -ex2 || fy !== -ey2)) addOpening([i, y2 * W + x2], a, b);
          }
        }
      }
    }
  const orbitKey = (tiles: number[]) => {
    let best = '';
    for (const f of group) {
      const img = tiles
        .map((i) => {
          const x = i % W;
          const [gx, gy] = f(x, (i - x) / W);
          return gy * W + gx;
        })
        .sort((p, q) => p - q)
        .join(',');
      if (best === '' || img < best) best = img;
    }
    return best;
  };
  const orbits = new Map<string, Opening[]>();
  for (const o of openings.values()) {
    const k = orbitKey(o.tiles);
    let list = orbits.get(k);
    if (!list) orbits.set(k, (list = []));
    list.push(o);
  }
  const keys = [...orbits.keys()].sort();
  const singles = shuffle(keys.filter((k) => !k.includes(',')), rng);
  const doubles = shuffle(keys.filter((k) => k.includes(',')), rng);
  const ds = new DisjointSet(raw.length);
  const linked = new Set<string>();
  const doorCands: number[] = [];
  const open = (orbit: Opening[]) => {
    const door = rng.chance(doorShare); // one decision per symmetric set
    for (const o of orbit) {
      ds.union(o.a, o.b);
      linked.add(`${o.a}:${o.b}`);
      if (door && o.tiles.length === 1) doorCands.push(o.tiles[0]);
      for (const i of o.tiles) g.set(i % W, Math.floor(i / W), 'floor', null);
    }
  };
  const stillWall = (orbit: Opening[]) => orbit.every((o) => o.tiles.every((i) => g.tiles[i].kind === 'wall'));
  for (const list of [singles, doubles])
    for (const k of list) {
      const orbit = orbits.get(k)!;
      if (stillWall(orbit) && orbit.some((o) => ds.find(o.a) !== ds.find(o.b))) open(orbit);
    }
  // circuits: extra openings between cells that are not yet directly linked
  for (const k of singles) {
    const orbit = orbits.get(k)!;
    if (!stillWall(orbit) || orbit.some((o) => linked.has(`${o.a}:${o.b}`))) continue;
    if (rng.chance(loops * 0.5)) open(orbit);
  }

  // ---- regions, names and pillars ---------------------------------------------------------
  const regionOf = new Int32Array(raw.length).fill(-1);
  const sizeOf = new Int32Array(raw.length);
  for (let i = 0; i < N; i++) {
    const c = floorCell(i);
    if (c >= 0 && g.tiles[i].region === undefined) sizeOf[c]++;
  }
  const centreCell = cell[Math.round(cy) * W + Math.round(cx)];
  for (let c = 0; c < raw.length; c++) {
    if (sizeOf[c] < 3) continue;
    regionOf[c] = g.newRegion();
    let name = ringNames.get(raw[c].replace(/s\d+$/, '')) ?? baseName;
    if (variant !== 0 && c === centreCell) name = `central ${name}`;
    ctx.regionNames.set(regionOf[c], name);
  }
  for (let i = 0; i < N; i++) {
    const c = cell[i];
    if (c >= 0 && regionOf[c] >= 0 && g.tiles[i].kind === 'floor') g.tiles[i].region = regionOf[c];
  }
  // pillars: decided once per symmetric set of cells (same key), placed at each cell's centroid
  const decided = new Map<number, boolean>();
  const sums = new Map<number, { sx: number; sy: number; n: number }>();
  for (let i = 0; i < N; i++) {
    const c = floorCell(i);
    if (c < 0) continue;
    const s = sums.get(c) ?? { sx: 0, sy: 0, n: 0 };
    s.sx += i % W;
    s.sy += Math.floor(i / W);
    s.n++;
    sums.set(c, s);
  }
  const passable = (x: number, y: number) => g.passable(x, y);
  for (let c = 0; c < raw.length; c++) {
    const s = sums.get(c);
    if (!s || s.n < 30) continue;
    let yes = decided.get(key[c]);
    if (yes === undefined) decided.set(key[c], (yes = rng.chance(pillarChance)));
    if (!yes) continue;
    const px = Math.round(s.sx / s.n);
    const py = Math.round(s.sy / s.n);
    const big = s.n >= 70;
    const shape = big ? [[0, 0], ...DIRS4] : [[0, 0]];
    if (!RING8.every(([dx, dy]) => floorCell((py + dy) * W + px + dx) === c)) continue;
    for (const [dx, dy] of shape) {
      const x = px + dx;
      const y = py + dy;
      if (floorCell(y * W + x) === c && canBlockLocally(passable, x, y)) g.set(x, y, 'wall', null);
    }
  }

  // doors last, once the surroundings are final: only where walls flank the gap
  for (const i of doorCands) {
    const x = i % W;
    const y = (i - x) / W;
    const doorway =
      (g.passable(x - 1, y) && g.passable(x + 1, y) && g.kind(x, y - 1) === 'wall' && g.kind(x, y + 1) === 'wall') ||
      (g.passable(x, y - 1) && g.passable(x, y + 1) && g.kind(x - 1, y) === 'wall' && g.kind(x + 1, y) === 'wall');
    if (doorway && g.kind(x, y) === 'floor') g.set(x, y, 'door', null);
  }

  ctx.carveDoors = doorShare > 0;
  ctx.dropBelow = 4;
  ctx.voronoi = 0;
}
