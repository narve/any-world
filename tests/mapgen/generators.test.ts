import { describe, expect, it } from 'vitest';
import { GENERATOR_NAMES, MAP_SIZES, PASSABLE_KINDS, generateArea, renderAscii, seededRng, validateMap } from '../../src/engine/mapgen';
import type { AreaMap } from '../../src/engine/types';
import { emptyWorld, makePlan, passableCount, reachable } from './helpers';

const SIZES = ['small', 'medium', 'large'] as const;
const SEEDS = Array.from({ length: 50 }, (_, i) => i * 7919 + 1);

function checkMap(map: AreaMap, label: string): string[] {
  const problems: string[] = [];
  const W = map.width;
  const H = map.height;
  const at = (x: number, y: number) => map.tiles[y * W + x];
  // start / exit
  if (map.start.x === map.exit.x && map.start.y === map.exit.y) problems.push('start == exit');
  if (at(map.start.x, map.start.y).kind !== 'start') problems.push('start tile kind');
  if (at(map.exit.x, map.exit.y).kind !== 'transition') problems.push('exit tile kind');
  // connectivity: exit reachable and every passable tile reachable
  const r = reachable(map, map.start);
  if (!r.has(map.exit.y * W + map.exit.x)) problems.push('exit not reachable');
  if (r.size !== passableCount(map)) problems.push(`unreachable passable tiles: ${passableCount(map) - r.size}`);
  // closed border
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (PASSABLE_KINDS.has(at(x, y).kind) || at(x, y).kind === 'water') problems.push(`border ${x},${y}`);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (PASSABLE_KINDS.has(at(x, y).kind) || at(x, y).kind === 'water') problems.push(`border ${x},${y}`);
  // every passable tile is enclosed: no passable tile touches void
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (!PASSABLE_KINDS.has(at(x, y).kind)) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy).kind === 'void') problems.push(`open tile ${x},${y} touches void`);
    }
  // far apart
  const d = Math.hypot(map.start.x - map.exit.x, map.start.y - map.exit.y);
  if (d < 0.4 * Math.hypot(W, H)) problems.push(`start/exit too close (${d.toFixed(1)})`);
  // regions
  if (map.regions.length < 2) problems.push(`only ${map.regions.length} regions`);
  map.regions.forEach((rg, i) => {
    if (rg.id !== i) problems.push(`region id ${rg.id} at index ${i}`);
    if (rg.size <= 0) problems.push(`region ${i} empty`);
    const c = at(rg.centre.x, rg.centre.y);
    if (c.region !== rg.id) problems.push(`region ${i} centre not inside region`);
  });
  for (const t of map.tiles) if (t.region !== undefined && (t.region < 0 || t.region >= map.regions.length)) problems.push('tile region out of range');
  // the playable shape uses a decent share of the map
  if (passableCount(map) < W * H * 0.15) problems.push(`too little floor (${passableCount(map)})`);
  return problems.slice(0, 5).map((p) => `${label}: ${p}`);
}

describe('mapgen generators', () => {
  for (const gen of GENERATOR_NAMES) {
    for (const size of SIZES) {
      it(`${gen} / ${size}: invariants over ${SEEDS.length} seeds`, () => {
        const problems: string[] = [];
        let slowest = 0;
        const times: number[] = [];
        for (const seed of SEEDS) {
          const t0 = performance.now();
          const map = generateArea(makePlan(gen, size), emptyWorld, seededRng(seed));
          const ms = performance.now() - t0;
          times.push(ms);
          slowest = Math.max(slowest, ms);
          expect(map.width).toBe(MAP_SIZES[size].width);
          expect(map.height).toBe(MAP_SIZES[size].height);
          problems.push(...validateMap(map).map((p) => `${gen}/${size}/${seed}: ${p}`));
          const pr = checkMap(map, `${gen}/${size}/${seed}`);
          if (pr.length && problems.length < 3) problems.push(renderAscii(map));
          problems.push(...pr);
        }
        expect(problems).toEqual([]);
        // performance: median well under budget, worst case < 50ms (JIT warm-up excluded)
        times.sort((a, b) => a - b);
        expect(times[Math.floor(times.length / 2)]).toBeLessThan(50);
        expect(times[times.length - 2]).toBeLessThan(50);
      });
    }

    it(`${gen}: deterministic for a given seed`, () => {
      for (const size of SIZES) {
        for (const seed of SEEDS.slice(0, 10)) {
          const a = generateArea(makePlan(gen, size), emptyWorld, seededRng(seed));
          const b = generateArea(makePlan(gen, size), emptyWorld, seededRng(seed));
          expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        }
      }
    });

    it(`${gen}: different seeds give different maps`, () => {
      const a = renderAscii(generateArea(makePlan(gen), emptyWorld, seededRng(1)));
      const b = renderAscii(generateArea(makePlan(gen), emptyWorld, seededRng(2)));
      expect(a).not.toBe(b);
    });
  }
});

describe('mapgen features', () => {
  const doorGens = ['rooms', 'building', 'town', 'ship', 'arena'] as const;
  for (const gen of doorGens) {
    it(`${gen} marks doors`, () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const map = generateArea(makePlan(gen), emptyWorld, seededRng(seed));
        expect(map.tiles.some((t) => t.kind === 'door')).toBe(true);
      }
    });
  }

  it('doors sit between walls (not floating in the open)', () => {
    for (const gen of doorGens) {
      for (const seed of SEEDS.slice(0, 10)) {
        const map = generateArea(makePlan(gen), emptyWorld, seededRng(seed));
        const W = map.width;
        map.tiles.forEach((t, i) => {
          if (t.kind !== 'door') return;
          const x = i % W;
          const y = (i - x) / W;
          const k = (dx: number, dy: number) => map.tiles[(y + dy) * W + x + dx].kind;
          const solid = (kk: string) => kk === 'wall' || kk === 'void';
          const ew = solid(k(0, -1)) && solid(k(0, 1));
          const ns = solid(k(-1, 0)) && solid(k(1, 0));
          expect(ew || ns, `${gen}/${seed} door at ${x},${y}\n${renderAscii(map)}`).toBe(true);
        });
      }
    }
  });

  it('lamps follow lighting.lamps.frequency and sit on walls or floor', () => {
    for (const gen of GENERATOR_NAMES) {
      const none = generateArea(makePlan(gen, 'medium', {}, 0), emptyWorld, seededRng(5));
      expect(none.tiles.some((t) => t.lamp)).toBe(false);
      const low = generateArea(makePlan(gen, 'medium', {}, 0.03), emptyWorld, seededRng(5)).tiles.filter((t) => t.lamp).length;
      const high = generateArea(makePlan(gen, 'medium', {}, 0.3), emptyWorld, seededRng(5));
      const highN = high.tiles.filter((t) => t.lamp).length;
      expect(low).toBeGreaterThan(0);
      expect(highN).toBeGreaterThan(low);
      for (const t of high.tiles) if (t.lamp) expect(['wall', 'floor']).toContain(t.kind);
    }
  });

  it('rooms respects roomCount', () => {
    const few = generateArea(makePlan('rooms', 'large', { roomCount: 4 }), emptyWorld, seededRng(3));
    const many = generateArea(makePlan('rooms', 'large', { roomCount: 16 }), emptyWorld, seededRng(3));
    expect(few.regions.length).toBeLessThanOrEqual(4);
    expect(many.regions.length).toBeGreaterThan(few.regions.length + 4);
  });

  it('town respects buildings', () => {
    const count = (n: number) => generateArea(makePlan('town', 'large', { buildings: n }), emptyWorld, seededRng(9)).regions.length;
    expect(count(3)).toBeLessThan(count(14));
  });

  it('caves openness changes floor share', () => {
    let tight = 0;
    let open = 0;
    for (const seed of SEEDS.slice(0, 10)) {
      tight += passableCount(generateArea(makePlan('caves', 'medium', { openness: 0 }), emptyWorld, seededRng(seed)));
      open += passableCount(generateArea(makePlan('caves', 'medium', { openness: 1 }), emptyWorld, seededRng(seed)));
    }
    expect(open).toBeGreaterThan(tight);
  });

  it('arena pillarDensity changes pillar count', () => {
    const walls = (d: number) =>
      generateArea(makePlan('arena', 'large', { pillarDensity: d }), emptyWorld, seededRng(4)).tiles.filter((t) => t.kind === 'wall').length;
    expect(walls(1)).toBeGreaterThan(walls(0));
  });

  it('unknown params are ignored and extreme params still yield valid maps', () => {
    const extremes: Record<string, number>[] = [
      { roomCount: 30, rooms: 30, buildings: 40, openness: 0, cover: 0.5, pillarDensity: 1, loops: 0.6, corridorWidth: 4, streetWidth: 5 },
      { roomCount: 2, buildings: 1, openness: 1, pillarDensity: 0, loops: 0, deadEnds: 0, corridorWidth: 1, smoothing: 8, nonsense: 99 },
    ];
    for (const gen of GENERATOR_NAMES)
      for (const size of SIZES)
        for (const params of extremes)
          for (const seed of [1, 2, 3]) {
            const map = generateArea(makePlan(gen, size, params), emptyWorld, seededRng(seed));
            expect(validateMap(map), `${gen}/${size}/${JSON.stringify(params)}`).toEqual([]);
          }
  });
});
