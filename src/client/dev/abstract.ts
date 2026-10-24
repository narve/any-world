/**
 * Dev-only stand-ins for the non-realistic layouts (islands / organic / geometric) and a synthetic
 * "dream" world, so the renderer can be checked before (or independently of) mapgen and the
 * fixture-dream content. The game never uses these: mapgen owns real layouts.
 *
 * Every map satisfies the AreaMap contract: one connected passable region, a 'start' and a
 * 'transition' tile, impassable borders.
 */
import type { WorldSpec, AreaPlan } from '../../schema/world';
import type { AreaMap, Pos, Rng, Tile } from '../../engine/types';

export const ABSTRACT_GENERATORS = ['islands', 'organic', 'geometric'] as const;
export type AbstractGenerator = (typeof ABSTRACT_GENERATORS)[number];

const PASS = new Set(['floor', 'start', 'door', 'door_open', 'transition', 'water']);

function grid(W: number, H: number, kind: Tile['kind']): Tile[] {
  return Array.from({ length: W * H }, () => ({ kind }));
}

/** label connected passable components (4-neighbour); returns component id per tile (-1 = blocked) */
function components(W: number, H: number, tiles: Tile[]): { comp: Int32Array; sizes: number[] } {
  const comp = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (comp[s] >= 0 || !PASS.has(tiles[s].kind)) continue;
    const id = sizes.length;
    const q = [s];
    comp[s] = id;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % W;
      const y = Math.floor(i / W);
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (comp[j] >= 0 || !PASS.has(tiles[j].kind)) continue;
        comp[j] = id;
        q.push(j);
      }
    }
    sizes.push(q.length);
  }
  return { comp, sizes };
}

/** carve an L-shaped corridor of `kind` between two points (only through non-passable tiles) */
function carve(W: number, tiles: Tile[], a: Pos, b: Pos, kind: Tile['kind'] = 'floor'): void {
  let x = a.x;
  let y = a.y;
  const put = () => {
    const t = tiles[y * W + x];
    if (!PASS.has(t.kind)) tiles[y * W + x] = { kind };
  };
  while (x !== b.x) {
    put();
    x += Math.sign(b.x - x);
  }
  while (y !== b.y) {
    put();
    y += Math.sign(b.y - y);
  }
  put();
}

/** join every passable component to the largest one with corridors, then fix borders */
function connect(W: number, H: number, tiles: Tile[], kind: Tile['kind'] = 'floor'): void {
  for (let guard = 0; guard < 40; guard++) {
    const { comp, sizes } = components(W, H, tiles);
    if (sizes.length <= 1) return;
    const main = sizes.indexOf(Math.max(...sizes));
    // nearest pair between some other component and the main one
    let best: [number, number] | null = null;
    let bd = Infinity;
    const mainTiles: number[] = [];
    const other: number[] = [];
    const target = comp.findIndex((c, i) => c >= 0 && c !== main && i >= 0);
    for (let i = 0; i < W * H; i++) {
      if (comp[i] === main) mainTiles.push(i);
      else if (comp[i] === comp[target]) other.push(i);
    }
    for (const a of other)
      for (const b of mainTiles) {
        const d = Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W));
        if (d < bd) {
          bd = d;
          best = [a, b];
        }
      }
    if (!best) return;
    carve(W, tiles, { x: best[0] % W, y: Math.floor(best[0] / W) }, { x: best[1] % W, y: Math.floor(best[1] / W) }, kind);
  }
}

function seal(W: number, H: number, tiles: Tile[], edge: Tile['kind']): void {
  for (let x = 0; x < W; x++)
    for (const y of [0, H - 1]) if (PASS.has(tiles[y * W + x].kind)) tiles[y * W + x] = { kind: edge };
  for (let y = 0; y < H; y++)
    for (const x of [0, W - 1]) if (PASS.has(tiles[y * W + x].kind)) tiles[y * W + x] = { kind: edge };
}

function farthestPair(W: number, H: number, tiles: Tile[], from: Pos): Pos {
  const d = new Int32Array(W * H).fill(-1);
  const q = [from.y * W + from.x];
  d[q[0]] = 0;
  let last = q[0];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    last = i;
    const x = i % W;
    const y = Math.floor(i / W);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (d[j] >= 0 || !PASS.has(tiles[j].kind) || tiles[j].kind === 'water') continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  return { x: last % W, y: Math.floor(last / W) };
}

function finish(W: number, H: number, tiles: Tile[], start: Pos, plan: AreaPlan, rng: Rng, regions: AreaMap['regions']): AreaMap {
  tiles[start.y * W + start.x] = { kind: 'start' };
  const exit = farthestPair(W, H, tiles, start);
  tiles[exit.y * W + exit.x] = { kind: 'transition' };
  const freq = plan.lighting?.lamps?.frequency ?? 0;
  if (freq > 0)
    for (let i = 0; i < W * H; i++) if (tiles[i].kind === 'floor' && rng.chance(freq * 0.05)) tiles[i].lamp = true;
  return { width: W, height: H, tiles, start, exit, regions };
}

/** Floating platforms over a void joined by one-tile bridges, with a few ruined walls on them. */
export function islandsMap(plan: AreaPlan, rng: Rng): AreaMap {
  const W = 46;
  const H = 34;
  const tiles = grid(W, H, 'void');
  const isles: { c: Pos; r: number }[] = [];
  for (let tries = 0; tries < 300 && isles.length < 8; tries++) {
    const r = rng.int(3, 5);
    const c = { x: rng.int(r + 2, W - r - 3), y: rng.int(r + 2, H - r - 3) };
    if (isles.some((o) => Math.hypot(o.c.x - c.x, o.c.y - c.y) < o.r + r + 3)) continue;
    isles.push({ c, r });
  }
  isles.forEach((isle, k) => {
    for (let y = isle.c.y - isle.r - 1; y <= isle.c.y + isle.r + 1; y++)
      for (let x = isle.c.x - isle.r - 1; x <= isle.c.x + isle.r + 1; x++) {
        const wob = Math.sin(x * 1.3 + k) * 0.6 + Math.cos(y * 1.1 - k) * 0.6;
        if (Math.hypot(x - isle.c.x, (y - isle.c.y) * 1.1) <= isle.r + wob) tiles[y * W + x] = { kind: 'floor', region: k };
      }
    // a broken arch / ruin on bigger islands
    if (isle.r >= 4) {
      for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || rng.chance(0.3)) tiles[(isle.c.y - 2) * W + isle.c.x + dx] = { kind: 'wall' };
      tiles[(isle.c.y - 1) * W + isle.c.x - 2] = { kind: 'wall' };
    }
  });
  // bridges along a chain (nearest neighbour order)
  const order = [0];
  const left = new Set(isles.map((_, i) => i).slice(1));
  while (left.size) {
    const cur = isles[order[order.length - 1]];
    let best = -1;
    let bd = Infinity;
    for (const i of left) {
      const d = Math.hypot(isles[i].c.x - cur.c.x, isles[i].c.y - cur.c.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    order.push(best);
    left.delete(best);
  }
  for (let k = 1; k < order.length; k++) carve(W, tiles, isles[order[k - 1]].c, isles[order[k]].c);
  connect(W, H, tiles);
  seal(W, H, tiles, 'void');
  const start = isles[0].c;
  return finish(W, H, tiles, start, plan, rng, isles.map((s, i) => ({ id: i, centre: s.c, size: Math.round(Math.PI * s.r * s.r) })));
}

/** Membranes and blobs: cellular-automaton chambers with tube-like passages and a few fluid pools. */
export function organicMap(plan: AreaPlan, rng: Rng): AreaMap {
  const W = 44;
  const H = 34;
  let tiles = grid(W, H, 'wall');
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rng.chance(0.55)) tiles[y * W + x] = { kind: 'floor' };
  for (let it = 0; it < 5; it++) {
    const next = grid(W, H, 'wall');
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        let walls = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (tiles[(y + oy) * W + x + ox].kind === 'wall') walls++;
        next[y * W + x] = { kind: walls >= 5 ? 'wall' : 'floor' };
      }
    tiles = next;
  }
  connect(W, H, tiles);
  // pools of fluid in wide spots
  let pools = 0;
  for (let y = 3; y < H - 3 && pools < 3; y += 5)
    for (let x = 3; x < W - 3 && pools < 3; x += 7) {
      let open = true;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (tiles[(y + oy) * W + x + ox].kind !== 'floor') open = false;
      if (open && rng.chance(0.5)) {
        tiles[y * W + x] = { kind: 'water' };
        tiles[y * W + x + 1] = { kind: 'water' };
        if (rng.chance(0.6)) tiles[(y + 1) * W + x] = { kind: 'water' };
        pools++;
      }
    }
  seal(W, H, tiles, 'wall');
  let start: Pos = { x: Math.floor(W / 2), y: Math.floor(H / 2) };
  for (let r = 0; r < 30; r++) {
    const found = tiles.findIndex((t, i) => t.kind === 'floor' && Math.abs((i % W) - start.x) <= r && Math.abs(Math.floor(i / W) - start.y) <= r);
    if (found >= 0) {
      start = { x: found % W, y: Math.floor(found / W) };
      break;
    }
  }
  return finish(W, H, tiles, start, plan, rng, [{ id: 0, centre: start, size: 100 }]);
}

/** Concentric rings with gates on the axes, a pillar lattice in the core, floating in a void. */
export function geometricMap(plan: AreaPlan, rng: Rng): AreaMap {
  const W = 43;
  const H = 43;
  const tiles = grid(W, H, 'void');
  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = Math.max(Math.abs(x - cx), Math.abs(y - cy)); // square rings
      if (r > 19) continue;
      if (r % 5 === 0 && r > 0) {
        // ring wall with gates on the axes / diagonals (alternating per ring)
        const ring = r / 5;
        const onAxis = x === cx || y === cy;
        const onDiag = Math.abs(x - cx) === Math.abs(y - cy);
        tiles[y * W + x] = { kind: (ring % 2 ? onAxis : onDiag) ? 'floor' : 'wall' };
        if (r === 20) tiles[y * W + x] = { kind: 'void' };
      } else {
        tiles[y * W + x] = { kind: 'floor', region: Math.floor(r / 5) };
        // pillar lattice inside the core and checker voids in the outer band
        if (r < 5 && r > 1 && (x - cx) % 2 === 0 && (y - cy) % 2 === 0) tiles[y * W + x] = { kind: 'wall' };
        if (r > 15 && (x + y) % 4 === 0 && (x % 4 === 0 || y % 4 === 0)) tiles[y * W + x] = { kind: 'void' };
      }
    }
  connect(W, H, tiles);
  seal(W, H, tiles, 'void');
  const start = { x: cx, y: cy + 2 };
  void rng;
  return finish(W, H, tiles, start, plan, rng, [0, 1, 2, 3].map((k) => ({ id: k, centre: { x: cx, y: cy }, size: 50 })));
}

export function abstractMap(generator: string, plan: AreaPlan, rng: Rng): AreaMap | null {
  switch (generator) {
    case 'islands':
      return islandsMap(plan, rng);
    case 'organic':
      return organicMap(plan, rng);
    case 'geometric':
      return geometricMap(plan, rng);
    default:
      return null;
  }
}

/**
 * A synthetic dream world for dev pages: the given world (models, items, actors) with areas that
 * exercise the non-realistic generators, abstract patterns and every backdrop style.
 */
export function syntheticDreamWorld(base: WorldSpec): WorldSpec {
  const a0 = base.areas[0];
  const mk = (p: Partial<AreaPlan>): AreaPlan => ({ ...a0, ...p, lighting: { ...a0.lighting, ...(p.lighting ?? {}) } }) as AreaPlan;
  const areas: AreaPlan[] = [
    mk({
      name: 'The Drifting Steps',
      generator: 'islands',
      floor: { color: '#c9b8e8', color2: '#9d86c9', material: 'stone', pattern: 'gradient' },
      wall: { color: '#e6dcf5', color2: '#b6a2dd', material: 'stone', height: 1.2, pattern: 'plain' },
      lighting: { ambient: '#8f7fc0', ambientIntensity: 0.6, playerLight: 4, sun: undefined, fog: undefined, lamps: undefined, sky: undefined },
      backdrop: { style: 'starfield', color: '#0b0820', color2: '#a98bff', intensity: 0.7 },
    }),
    mk({
      name: 'The Warm Interior',
      generator: 'organic',
      floor: { color: '#8a3b4a', color2: '#5e2333', material: 'skin', pattern: 'noise' },
      wall: { color: '#c0566a', color2: '#e58a8f', material: 'skin', height: 1.6, pattern: 'plain' },
      lighting: { ambient: '#ff8c8c', ambientIntensity: 0.3, playerLight: 5, sun: undefined, fog: { color: '#2a0a12', density: 0.05 }, lamps: { color: '#ffb3a0', intensity: 1.2, frequency: 0.3, flicker: true }, sky: undefined },
      backdrop: { style: 'abyss', color: '#3a0d18', color2: '#ff9a8a', intensity: 0.6 },
    }),
    mk({
      name: 'The Theorem Gardens',
      generator: 'geometric',
      floor: { color: '#1d2333', color2: '#4cc9f0', material: 'glass', pattern: 'grid' },
      wall: { color: '#272f45', color2: '#7df9ff', material: 'metal', height: 1.0, pattern: 'lines' },
      lighting: { ambient: '#6b7cff', ambientIntensity: 0.35, playerLight: 4, sun: undefined, fog: undefined, lamps: undefined, sky: undefined },
      backdrop: { style: 'grid', color: '#070a1a', color2: '#ff4fd8', intensity: 0.6 },
    }),
    mk({
      name: 'Above the Cloud Sea',
      generator: 'islands',
      floor: { color: '#9fc27a', color2: '#7aa35a', material: 'stone', pattern: 'grass' },
      wall: { color: '#d8cfc0', color2: '#a89e8c', material: 'stone', height: 1.4, pattern: 'cobble' },
      lighting: { ambient: '#fff3dd', ambientIntensity: 0.55, playerLight: 3, sun: { color: '#fff1d0', intensity: 1, elevation: 55 }, fog: undefined, lamps: undefined, sky: undefined },
      backdrop: { style: 'clouds', color: '#bcd7f5', color2: '#6f8fc0', intensity: 0.5 },
    }),
    mk({
      name: 'The Aurora Shelf',
      generator: 'islands',
      floor: { color: '#3a4a5c', color2: '#2a3646', material: 'stone', pattern: 'lines' },
      wall: { color: '#5b6f86', color2: '#9fd6c8', material: 'stone', height: 1.3, pattern: 'plain' },
      lighting: { ambient: '#7fd6c0', ambientIntensity: 0.3, playerLight: 4, sun: undefined, fog: undefined, lamps: undefined, sky: undefined },
      backdrop: { style: 'aurora', color: '#05101a', color2: '#4dffb0', intensity: 0.7 },
    }),
  ];
  return { ...base, meta: { ...base.meta, title: `${base.meta.title} (dream test)` }, areas };
}
