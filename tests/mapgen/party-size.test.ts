/**
 * MP1 B3: maps for a party. `generateArea(plan, world, rng, { partySize })` grows width and height
 * by √(1 + 0.15·(n − 1)) (about +15 % area per extra player; 12 players: large 56×40 → 91×65).
 * Every generator must still give a valid, connected map at the bigger sizes; a party of one gets
 * exactly today's maps.
 */
import { describe, expect, it } from 'vitest';
import { GENERATOR_NAMES, MAP_SIZES, generateArea, mapDimensions, seededRng, validateMap } from '../../src/engine/mapgen';
import { OPEN_EDGED, checkMap, cpuMs, emptyWorld, makePlan } from './helpers';

const SIZES = ['small', 'medium', 'large'] as const;
const SEEDS = [1, 7920, 15839, 23758];

function check(gen: (typeof GENERATOR_NAMES)[number], size: (typeof SIZES)[number], n: number, seeds: number[]): string[] {
  const problems: string[] = [];
  const want = mapDimensions(size, n);
  for (const seed of seeds) {
    const map = generateArea(makePlan(gen, size), emptyWorld, seededRng(seed), { partySize: n });
    const tag = `${gen}/${size}/n${n}/${seed}`;
    if (map.width !== want.width || map.height !== want.height) problems.push(`${tag}: ${map.width}×${map.height}, want ${want.width}×${want.height}`);
    problems.push(...validateMap(map).map((p) => `${tag}: ${p}`));
    problems.push(...checkMap(map, tag, OPEN_EDGED.has(gen)));
  }
  return problems;
}

describe('map size by party', () => {
  it('dimensions grow with the party; a party of one keeps MAP_SIZES', () => {
    for (const size of SIZES) {
      expect(mapDimensions(size, 1)).toEqual(MAP_SIZES[size]);
      expect(mapDimensions(size, 0)).toEqual(MAP_SIZES[size]);
    }
    expect(mapDimensions('large', 12)).toEqual({ width: 91, height: 65 });
    expect(mapDimensions('small', 2)).toEqual({ width: 34, height: 26 });
    // beyond the most players a party can have, the size stops growing
    expect(mapDimensions('large', 40)).toEqual(mapDimensions('large', 12));
    let prev = 0;
    for (let n = 1; n <= 12; n++) {
      const d = mapDimensions('medium', n);
      const area = d.width * d.height;
      expect(area).toBeGreaterThan(prev);
      // ≈ +15 % of the solo area per extra player
      expect(area / (44 * 32)).toBeCloseTo(1 + 0.15 * (n - 1), 1);
      prev = area;
    }
  });

  it('a party of one (or no options) gives exactly the single-player map', () => {
    for (const gen of GENERATOR_NAMES) {
      const a = generateArea(makePlan(gen, 'medium'), emptyWorld, seededRng(5));
      const b = generateArea(makePlan(gen, 'medium'), emptyWorld, seededRng(5), { partySize: 1 });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  for (const gen of GENERATOR_NAMES) {
    it(`${gen}: valid at party size 4 on every size`, () => {
      const problems = SIZES.flatMap((size) => check(gen, size, 4, SEEDS));
      expect(problems).toEqual([]);
    });
  }

  for (const gen of ['rooms', 'caves', 'organic'] as const) {
    it(`${gen}: valid at party size 12 (91×65 when large), deterministic`, () => {
      const problems = SIZES.flatMap((size) => check(gen, size, 12, SEEDS.slice(0, 3)));
      expect(problems).toEqual([]);
      const a = generateArea(makePlan(gen, 'large'), emptyWorld, seededRng(9), { partySize: 12 });
      const b = generateArea(makePlan(gen, 'large'), emptyWorld, seededRng(9), { partySize: 12 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }

  it('a 91×65 map is generated in reasonable time (CPU time, so a loaded machine does not fail it)', () => {
    const times: number[] = [];
    for (const gen of GENERATOR_NAMES) {
      for (const seed of SEEDS.slice(0, 2)) {
        times.push(cpuMs(() => generateArea(makePlan(gen, 'large'), emptyWorld, seededRng(seed), { partySize: 12 })));
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(100);
    expect(times[times.length - 1]).toBeLessThan(500);
  });
});
