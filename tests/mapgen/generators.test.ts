import { describe, expect, it } from 'vitest';
import { GENERATOR_NAMES, MAP_SIZES, generateArea, renderAscii, seededRng, validateMap } from '../../src/engine/mapgen';
import { OPEN_EDGED, checkMap, emptyWorld, makePlan, passableCount } from './helpers';

const SIZES = ['small', 'medium', 'large'] as const;
const SEEDS = Array.from({ length: 50 }, (_, i) => i * 7919 + 1);

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
          const pr = checkMap(map, `${gen}/${size}/${seed}`, OPEN_EDGED.has(gen));
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
      // knobs of the non-realistic generators, at both ends
      { islandCount: 24, islandSize: 0, bridgeLength: 2, chambers: 16, chamberSize: 0, tubeWidth: 1, curl: 1, wobble: 1, variant: 3, cellSize: 4, frame: 2, symmetry: 4, pillars: 1, doors: 1 },
      { islandCount: 3, islandSize: 1, bridgeLength: 24, pockets: 1, rims: 1, chambers: 2, chamberSize: 1, tubeWidth: 4, wobble: 0, membranes: 1, nodules: 1, fluid: 1, variant: 0, rings: 8, spokes: 12, symmetry: 1, loops: 1 },
      { variant: 4, facets: 14, frame: 1, symmetry: 3, rings: 0, tessellation: 2, outcrops: 1, islands: 3, blobs: 2 },
      { variant: -5, symmetry: 99, rings: -1, cellSize: 99, facets: 0, islandCount: -1, chambers: 1e9, bridgeLength: 0 },
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
