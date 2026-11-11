/**
 * Place: the layout of a real place (docs/PLACE-PLAN.md §4). Rasterises the area's PlacePatch
 * (vector features in metres, from OpenStreetMap) onto the grid: streets and squares are open
 * ground, building footprints become walled interiors with a door towards the street, water is
 * water, trees stand where they stand. Streets, squares, parks and buildings keep their real names
 * as region names. Without a usable patch it falls back to `town`.
 *
 * Scale: a large map (56 tiles wide) spans the patch's `extent`; medium and small maps keep that
 * scale and show the middle of the patch; a party's bigger grid shows the same ground finer.
 */
import type { PlaceFeature, PlacePatch } from '../../../schema/place';
import type { Pos } from '../../types';
import { MAP_SIZES, type GenContext } from '../context';
import { DIRS4, canBlockLocally } from '../grid';
import { segmentDistance } from '../shapes';
import { genTown } from './town';

/** building types that stay one open hall (no inner walls) */
const HALLS: ReadonlySet<string> = new Set(['church', 'cathedral', 'chapel', 'place_of_worship', 'mosque', 'synagogue', 'temple', 'sports_hall', 'sports_centre', 'train_station', 'station', 'hangar', 'riding_hall', 'theatre', 'cinema', 'roof', 'greenhouse', 'stadium']);

type Pt = [number, number];

function points(f: PlaceFeature): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < f.geometry.length; i += 2) out.push([f.geometry[i]!, f.geometry[i + 1]!]);
  return out;
}

export function genPlace(ctx: GenContext): void {
  const patch: PlacePatch | undefined = ctx.patch;
  if (!patch || patch.features.length < 3) {
    genTown(ctx);
    return;
  }
  const { g, rng } = ctx;
  const W = g.w;
  const H = g.h;
  // metres per tile: the patch's extent over a large map's width, whatever this map's size
  const mpt = (patch.extent * MAP_SIZES[ctx.size].width) / (MAP_SIZES.large.width * W);
  // a district is drawn like a tourist map: one room per building, landmarks always enterable
  const district = patch.scale === 'district';
  const toTile = ([x, y]: Pt): Pt => [x / mpt + W / 2, y / mpt + H / 2];
  const inside = (x: number, y: number) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1;
  const idx = (x: number, y: number) => y * W + x;

  /** tiles whose centre lies inside the polygon (even-odd) */
  const fillPolygon = (ring: Pt[], paint: (x: number, y: number) => void): void => {
    const pts = ring.map(toTile);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    for (let ty = Math.max(1, Math.floor(minY)); ty <= Math.min(H - 2, Math.ceil(maxY)); ty++) {
      const cy = ty + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let tx = Math.max(1, Math.ceil(xs[k]! - 0.5)); tx <= Math.min(W - 2, Math.ceil(xs[k + 1]! - 0.5) - 1); tx++) paint(tx, ty);
    }
  };

  /** tiles whose centre is within `radius` tiles of the line */
  const strokeLine = (line: Pt[], radius: number, paint: (x: number, y: number) => void): void => {
    const pts = line.map(toTile);
    const r = Math.max(0.71, radius); // 0.71: a diagonal line still paints a 4-connected run
    const seen = new Set<number>();
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      for (let ty = Math.max(1, Math.floor(Math.min(ay, by) - r)); ty <= Math.min(H - 2, Math.ceil(Math.max(ay, by) + r)); ty++)
        for (let tx = Math.max(1, Math.floor(Math.min(ax, bx) - r)); tx <= Math.min(W - 2, Math.ceil(Math.max(ax, bx) + r)); tx++) {
          const k = idx(tx, ty);
          if (seen.has(k)) continue;
          if (segmentDistance(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= r) {
            seen.add(k);
            paint(tx, ty);
          }
        }
    }
  };

  const regionOf = new Map<string, number>();
  const namedRegion = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    let id = regionOf.get(name);
    if (id === undefined) {
      id = g.newRegion();
      regionOf.set(name, id);
      ctx.regionNames.set(id, name);
    }
    return id;
  };
  const of = (kind: PlaceFeature['kind']) => patch.features.filter((f) => f.kind === kind);

  // 1. ground
  const ground = g.newRegion();
  ctx.regionNames.set(ground, patch.name);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) g.set(x, y, 'floor', ground);

  // 2. green
  for (const f of of('green')) {
    const region = namedRegion(f.name);
    const sand = f.type === 'beach' || f.type === 'sand';
    fillPolygon(points(f), (x, y) => {
      const t = g.tile(x, y);
      t.surface = sand ? 'path' : 'grass';
      if (region !== undefined) t.region = region;
    });
  }

  // 3. water: areas, streams, and the sea on the right-hand side of coastlines
  const toWater = (x: number, y: number) => {
    const t = g.tile(x, y);
    g.set(x, y, 'water', null);
    delete t.surface;
  };
  const coast = new Uint8Array(W * H);
  const seeds: number[] = [];
  const landSeeds: number[] = [];
  for (const f of of('water')) {
    const pts = points(f);
    if (f.type === 'coastline') {
      strokeLine(pts, 0.71, (x, y) => (coast[idx(x, y)] = 1));
      const tp = pts.map(toTile);
      for (let i = 0; i + 1 < tp.length; i++) {
        const [ax, ay] = tp[i]!;
        const [bx, by] = tp[i + 1]!;
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.5) continue;
        // OpenStreetMap coastlines keep the land on their left; y grows south here, so right is (-dy, dx)
        for (const t of [0.25, 0.5, 0.75]) {
          const sx = Math.floor(ax + (bx - ax) * t + (-(by - ay) / len) * 1.6);
          const sy = Math.floor(ay + (by - ay) * t + ((bx - ax) / len) * 1.6);
          if (inside(sx, sy)) seeds.push(idx(sx, sy));
          const lx = Math.floor(ax + (bx - ax) * t - (-(by - ay) / len) * 1.6);
          const ly = Math.floor(ay + (by - ay) * t - ((bx - ax) / len) * 1.6);
          if (inside(lx, ly)) landSeeds.push(idx(lx, ly));
        }
      }
    } else if (f.width !== undefined) strokeLine(pts, f.width / mpt / 2, toWater);
    else fillPolygon(pts, toWater);
  }
  if (seeds.length) {
    const sea = new Uint8Array(W * H);
    const stack = seeds.filter((i) => !coast[i]);
    for (const i of stack) sea[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % W;
      const cy = (c - cx) / W;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inside(nx, ny)) continue;
        const k = idx(nx, ny);
        if (sea[k] || coast[k]) continue;
        sea[k] = 1;
        stack.push(k);
      }
    }
    // a coastline with a gap lets the sea onto the land side: then leave the sea out
    const leaked = landSeeds.filter((i) => sea[i]).length;
    if (leaked <= landSeeds.length * 0.15) for (let i = 0; i < sea.length; i++) if (sea[i]) toWater(i % W, (i - (i % W)) / W);
  }

  // 4. squares
  for (const f of of('square')) {
    const region = namedRegion(f.name);
    fillPolygon(points(f), (x, y) => {
      const t = g.tile(x, y);
      if (t.kind === 'water') g.set(x, y, 'floor', ground);
      t.surface = 'plaza';
      if (region !== undefined) t.region = region;
    });
  }

  // 5. rails, 6. roads and paths (a road over water is a bridge)
  const lineOnGround = (surface: 'rail' | 'road' | 'path') => (f: PlaceFeature) => {
    const region = surface === 'rail' ? undefined : namedRegion(f.name);
    strokeLine(points(f), (f.width ?? 3) / mpt / 2, (x, y) => {
      const t = g.tile(x, y);
      if (surface === 'path' && (t.surface === 'road' || t.surface === 'plaza')) return;
      if (t.kind === 'water') g.set(x, y, 'floor', ground);
      t.surface = surface;
      if (region !== undefined) t.region = region;
    });
  };
  of('rail').forEach(lineOnGround('rail'));
  // minor streets first, so the main street's name wins where they cross
  const roads = of('road').sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  // (on a district map only the named footpaths: the rest would be a tangle at 7 m per tile)
  of('path').filter((f) => !district || f.name).forEach(lineOnGround('path'));
  roads.forEach(lineOnGround('road'));
  const isStreet = (x: number, y: number) => {
    const s = g.tile(x, y).surface;
    return s === 'road' || s === 'path';
  };

  // 7. barriers: walls one tile wide, never across a street
  for (const f of of('barrier'))
    strokeLine(points(f), 0.5, (x, y) => {
      if (g.kind(x, y) === 'floor' && !isStreet(x, y)) {
        g.set(x, y, 'wall', null);
        delete g.tile(x, y).surface;
      }
    });

  // 8. buildings: footprints share their party walls
  const buildings = of('building');
  const owner = new Int32Array(W * H).fill(-1);
  // bigger first, so a small building inside a block keeps its own tiles
  const footprint = buildings.map((f) => {
    const p = points(f);
    let a = 0;
    for (let i = 0; i < p.length; i++) a += p[i]![0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * p[i]![1];
    return Math.abs(a) / 2;
  });
  const order = buildings.map((_, b) => b).sort((a, b) => footprint[b]! - footprint[a]! || a - b);
  const areaOf = new Map<number, number>();
  for (const b of order) {
    let n = 0;
    fillPolygon(points(buildings[b]!), (x, y) => {
      owner[idx(x, y)] = b;
      n++;
    });
    areaOf.set(b, n);
  }
  if (district) {
    // a named building too small to walk into at this scale gets a 4×4 footprint around its middle
    for (const b of order) {
      const f = buildings[b]!;
      if (!f.name || areaOf.get(b)! >= 12) continue;
      const p = points(f).map(toTile);
      const cx = Math.round(p.reduce((a, q) => a + q[0], 0) / p.length);
      const cy = Math.round(p.reduce((a, q) => a + q[1], 0) / p.length);
      for (let y = cy - 2; y <= cy + 1; y++)
        for (let x = cx - 2; x <= cx + 1; x++) {
          if (!inside(x, y)) continue;
          const o = owner[idx(x, y)]!;
          if (o === -1 || o === b || !buildings[o]!.name) owner[idx(x, y)] = b;
        }
      footprint[b] = Math.max(footprint[b]!, 0.01); // stays the "smaller" one: it keeps its tiles
    }
  }
  const own = (x: number, y: number) => (inside(x, y) ? owner[idx(x, y)]! : -1);
  const interior = new Map<number, number[]>();
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const b = owner[idx(x, y)]!;
      if (b === -1) continue;
      let wall = false;
      for (let dy = -1; dy <= 1 && !wall; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && own(x + dx, y + dy) === -1) wall = true;
      // between two buildings the bigger one gives up the tile: one shared wall, sealed diagonally too
      for (let dy = -1; dy <= 1 && !wall; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = own(x + dx, y + dy);
          if (o !== b && (footprint[o]! < footprint[b]! || (footprint[o] === footprint[b] && o < b))) wall = true;
        }
      const t = g.tile(x, y);
      delete t.surface;
      if (wall) g.set(x, y, 'wall', null);
      else {
        g.set(x, y, 'floor', null);
        let list = interior.get(b);
        if (!list) interior.set(b, (list = []));
        list.push(idx(x, y));
      }
    }

  // how far each tile is from a street (through anything): doors face the nearest street
  const streetDist = new Int32Array(W * H).fill(-1);
  {
    let frontier: number[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (g.kind(x, y) === 'floor' && own(x, y) === -1 && (isStreet(x, y) || g.tile(x, y).surface === 'plaza')) frontier.push(idx(x, y));
    if (!frontier.length) frontier = [idx(W >> 1, H >> 1)];
    for (const i of frontier) streetDist[i] = 0;
    while (frontier.length) {
      const next: number[] = [];
      for (const c of frontier) {
        const cx = c % W;
        const cy = (c - cx) / W;
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!g.inBounds(nx, ny)) continue;
          const k = idx(nx, ny);
          if (streetDist[k] !== -1) continue;
          streetDist[k] = streetDist[c]! + 1;
          next.push(k);
        }
      }
      frontier = next;
    }
  }

  const solid = (x: number, y: number) => !g.passable(x, y);
  for (const [b, tiles] of interior) {
    const f = buildings[b]!;
    if (tiles.length < 3) {
      // too small to enter: a solid block
      for (const i of tiles) g.set(i % W, (i - (i % W)) / W, 'wall', null);
      continue;
    }
    const region = g.newRegion();
    if (f.name) ctx.regionNames.set(region, f.name);
    const mine = new Set(tiles);
    for (const i of tiles) g.tiles[i]!.region = region;

    // doors: a wall tile between this building's floor and open ground outside, walls on both sides
    const cands: { i: number; d: number }[] = [];
    for (const i of tiles) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIRS4) {
        const wx = x + dx;
        const wy = y + dy;
        const ox = wx + dx;
        const oy = wy + dy;
        if (!inside(ox, oy) || own(wx, wy) !== b || g.kind(wx, wy) !== 'wall') continue;
        if (own(ox, oy) !== -1 || g.kind(ox, oy) !== 'floor') continue;
        if (!solid(wx + dy, wy + dx) || !solid(wx - dy, wy - dx)) continue;
        cands.push({ i: idx(wx, wy), d: streetDist[idx(ox, oy)]! });
      }
    }
    const doors: number[] = [];
    if (cands.length) {
      const best = Math.min(...cands.map((c) => c.d));
      const front = cands.filter((c) => c.d === best);
      const first = front[rng.int(0, front.length - 1)]!.i;
      doors.push(first);
      if (tiles.length > 60 || rng.chance(0.25)) {
        // a second door, far from the first
        const fx = first % W;
        const fy = (first - fx) / W;
        let far = -1;
        let farD = 5;
        for (const c of cands) {
          const d = Math.abs((c.i % W) - fx) + Math.abs(Math.floor(c.i / W) - fy) - c.d * 0.5;
          if (d > farD) {
            farD = d;
            far = c.i;
          }
        }
        if (far !== -1) doors.push(far);
      }
      for (const i of doors) g.set(i % W, (i - (i % W)) / W, 'door', null);
    }

    // inner walls: big footprints are split into rooms (halls stay open)
    if (!district && tiles.length >= 40 && !HALLS.has(f.type ?? '')) splitRooms(tiles, 0);

    function splitRooms(room: number[], depth: number): void {
      if (room.length < 36 || depth >= 3) return;
      let x1 = Infinity;
      let x2 = -Infinity;
      let y1 = Infinity;
      let y2 = -Infinity;
      for (const i of room) {
        const x = i % W;
        const y = (i - x) / W;
        x1 = Math.min(x1, x);
        x2 = Math.max(x2, x);
        y1 = Math.min(y1, y);
        y2 = Math.max(y2, y);
      }
      const alongX = x2 - x1 >= y2 - y1;
      const lo = alongX ? x1 : y1;
      const hi = alongX ? x2 : y2;
      if (hi - lo < 7) return;
      const cut = rng.int(lo + 3, hi - 3);
      const coord = (i: number) => (alongX ? i % W : Math.floor(i / W));
      const other = (i: number) => (alongX ? Math.floor(i / W) : i % W);
      const step = alongX ? W : 1; // along the wall
      const across = alongX ? 1 : W;
      const line = room.filter((i) => coord(i) === cut).sort((a, b) => other(a) - other(b));
      // never wall up a tile next to a door
      const nearDoor = (i: number) => [i - 1, i + 1, i - W, i + W].some((k) => g.tiles[k]!.kind === 'door');
      const runs: number[][] = [];
      for (const i of line) {
        if (nearDoor(i)) continue;
        const last = runs[runs.length - 1];
        if (last && other(i) === other(last[last.length - 1]!) + 1) last.push(i);
        else runs.push([i]);
      }
      for (const run of runs) {
        for (const i of run) {
          g.tiles[i]!.kind = 'wall';
          delete g.tiles[i]!.region;
        }
        // one door per run, where there is floor on both sides and wall along the run
        const spots = run.filter((i) => {
          const a = g.tiles[i - across]!;
          const c = g.tiles[i + across]!;
          return a.kind === 'floor' && c.kind === 'floor' && mine.has(i - across) && mine.has(i + across) && g.tiles[i - step]!.kind === 'wall' && g.tiles[i + step]!.kind === 'wall';
        });
        const pick = spots.length ? spots[rng.int(0, spots.length - 1)]! : run[rng.int(0, run.length - 1)]!;
        if (spots.length) g.tiles[pick]!.kind = 'door';
        else {
          g.tiles[pick]!.kind = 'floor';
          g.tiles[pick]!.region = region;
        }
      }
      splitRooms(room.filter((i) => coord(i) < cut && g.tiles[i]!.kind === 'floor'), depth + 1);
      splitRooms(room.filter((i) => coord(i) > cut && g.tiles[i]!.kind === 'floor'), depth + 1);
    }
  }
  // footprints without any interior (sheds, thin wings) stay solid: nothing to do, they are wall

  // 9. trees: on open ground only, and never where one would close a passage
  const passable = (x: number, y: number) => g.passable(x, y);
  for (const f of of('tree')) {
    const [fx, fy] = toTile(points(f)[0]!);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (!inside(x, y) || own(x, y) !== -1 || g.kind(x, y) !== 'floor' || isStreet(x, y)) continue;
    let nearDoor = false;
    for (const [dx, dy] of DIRS4) if (g.kind(x + dx, y + dy) === 'door') nearDoor = true;
    if (nearDoor || !canBlockLocally(passable, x, y)) continue;
    g.set(x, y, 'wall', null);
    g.tile(x, y).prop = 'tree';
  }

  // whatever open ground is left unmapped reads as paving, so the area's own floor is the indoor floor
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const t = g.tile(x, y);
      if (own(x, y) === -1 && t.kind === 'floor' && !t.surface) t.surface = 'pavement';
    }

  ctx.carveDoors = true;
  ctx.pruneSpurs = 0; // real dead ends stay
  ctx.shortcuts = 0;
  ctx.dropBelow = 3; // a walled-in tile or two of yard is filled, not given a door

  // start in the middle of the place, leave along a street at the edge
  ctx.startExit = (grid) => {
    const outdoor = (x: number, y: number) => grid.kind(x, y) === 'floor' && own(x, y) === -1;
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    let exits: Pos[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (outdoor(x, y) && isStreet(x, y)) exits.push({ x, y });
    if (!exits.length) return null;
    // a patch with a focus: arrive by a street far from that building, the way on is inside it
    if (patch.focus) {
      const mine = order.filter((b) => buildings[b]!.name === patch.focus);
      let room: Pos[] = [];
      for (const b of mine) {
        const tiles: Pos[] = [];
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (own(x, y) === b && grid.kind(x, y) === 'floor') tiles.push({ x, y });
        if (tiles.length > room.length) room = tiles;
      }
      if (room.length) {
        const mx = room.reduce((a, p) => a + p.x, 0) / room.length;
        const my = room.reduce((a, p) => a + p.y, 0) / room.length;
        const exit = room.reduce((a, p) => (Math.hypot(p.x - mx, p.y - my) < Math.hypot(a.x - mx, a.y - my) ? p : a));
        const from = (p: Pos) => Math.hypot(p.x - exit.x, p.y - exit.y);
        const maxD = Math.max(...exits.map(from));
        const starts = exits.filter((p) => from(p) >= maxD - 2.5);
        return { start: starts[rng.int(0, starts.length - 1)]!, exit };
      }
    }
    const far = (p: Pos) => Math.hypot(p.x - cx, p.y - cy);
    const maxD = Math.max(...exits.map(far));
    exits = exits.filter((p) => far(p) >= maxD - 2.5);
    const exit = exits[rng.int(0, exits.length - 1)]!;
    const need = 0.4 * Math.hypot(W, H) + 0.5;
    let start: Pos | null = null;
    let best = Infinity;
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        if (!outdoor(x, y) || Math.hypot(x - exit.x, y - exit.y) < need) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d < best) {
          best = d;
          start = { x, y };
        }
      }
    return start ? { start, exit } : null;
  };
}
