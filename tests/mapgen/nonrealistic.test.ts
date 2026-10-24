/**
 * The non-realistic generators (M2): islands, organic, geometric. Wider seed sweep than the
 * generic suite, plus the layout properties each one promises and its knobs.
 */
import { describe, expect, it } from 'vitest';
import { PASSABLE_KINDS, generateArea, renderAscii, seededRng, validateMap } from '../../src/engine/mapgen';
import type { AreaMap } from '../../src/engine/types';
import { checkMap, emptyWorld, makePlan } from './helpers';

const NEW_GENS = ['islands', 'organic', 'geometric'] as const;
const SIZES = ['small', 'medium', 'large'] as const;
const SWEEP = Array.from({ length: 200 }, (_, i) => i * 104729 + 17);

const gen = (g: (typeof NEW_GENS)[number], size: (typeof SIZES)[number] = 'medium', params: Record<string, number> = {}, seed = 1) =>
  generateArea(makePlan(g, size, params), emptyWorld, seededRng(seed));

const kindAt = (m: AreaMap, x: number, y: number) => m.tiles[y * m.width + x].kind;
const open = (m: AreaMap, x: number, y: number) => PASSABLE_KINDS.has(kindAt(m, x, y));

/** share of interior tiles whose open/solid state matches their mirror image */
function mirrorAgreement(m: AreaMap, axis: 'x' | 'y'): number {
  let same = 0;
  let total = 0;
  for (let y = 1; y < m.height - 1; y++)
    for (let x = 1; x < m.width - 1; x++) {
      const mx = axis === 'x' ? m.width - 1 - x : x;
      const my = axis === 'y' ? m.height - 1 - y : y;
      total++;
      if (open(m, x, y) === open(m, mx, my)) same++;
    }
  return same / total;
}

describe('non-realistic generators: 200 seeds per size', () => {
  for (const g of NEW_GENS)
    for (const size of SIZES)
      it(`${g} / ${size}: finalize invariants hold, generator never falls back`, () => {
        const problems: string[] = [];
        for (const seed of SWEEP) {
          const map = gen(g, size, {}, seed);
          problems.push(...validateMap(map).map((p) => `${g}/${size}/${seed}: ${p}`));
          const pr = checkMap(map, `${g}/${size}/${seed}`, g === 'islands');
          if (pr.length && problems.length < 2) problems.push(renderAscii(map));
          problems.push(...pr);
          // every region of the new generators carries a structural name
          for (const r of map.regions) if (!r.name) problems.push(`${g}/${size}/${seed}: region ${r.id} has no name`);
          // the rooms fallback never names regions, and only islands leave floor next to void
          if (g === 'islands' && !map.tiles.some((t, i) => PASSABLE_KINDS.has(t.kind) && map.tiles[i - 1]?.kind === 'void'))
            problems.push(`${g}/${size}/${seed}: no open platform edge (fell back?)`);
          if (problems.length > 12) break;
        }
        expect(problems).toEqual([]);
      });
});

describe('islands', () => {
  it('platforms float over the void and are joined only by 1-wide bridges', () => {
    for (const seed of SWEEP.slice(0, 30)) {
      const m = gen('islands', 'medium', {}, seed);
      // no wall rim: some floor touches the void directly
      expect(m.tiles.some((t, i) => t.kind === 'floor' && [i - 1, i + 1, i - m.width, i + m.width].some((n) => m.tiles[n]?.kind === 'void'))).toBe(true);
      // two different platforms never touch (even diagonally); bridges carry no region
      for (let y = 1; y < m.height - 1; y++)
        for (let x = 1; x < m.width - 1; x++) {
          const r = m.tiles[y * m.width + x].region;
          if (r === undefined) continue;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const o = m.tiles[(y + dy) * m.width + x + dx].region;
              expect(o === undefined || o === r, `seed ${seed}: platforms ${r} and ${o} touch at ${x},${y}`).toBe(true);
            }
        }
      // bridge tiles are 1 wide: no 2x2 block made only of bridge tiles
      const bridge = (x: number, y: number) => open(m, x, y) && m.tiles[y * m.width + x].region === undefined;
      for (let y = 1; y < m.height - 2; y++)
        for (let x = 1; x < m.width - 2; x++)
          expect(bridge(x, y) && bridge(x + 1, y) && bridge(x, y + 1) && bridge(x + 1, y + 1), `seed ${seed} at ${x},${y}`).toBe(false);
      expect(m.regions.every((r) => r.name?.includes('platform'))).toBe(true);
    }
  });

  it('secluded platforms are dead ends reached by exactly one bridge tile', () => {
    let pockets = 0;
    for (const seed of SWEEP.slice(0, 30)) {
      const m = gen('islands', 'large', { pockets: 1 }, seed);
      for (const r of m.regions) {
        if (r.name !== 'secluded platform') continue;
        pockets++;
        const entries = new Set<number>();
        m.tiles.forEach((t, i) => {
          if (t.region !== r.id) return;
          for (const n of [i - 1, i + 1, i - m.width, i + m.width]) {
            const o = m.tiles[n];
            if (PASSABLE_KINDS.has(o.kind) && o.region !== r.id) entries.add(n);
          }
        });
        expect(entries.size, `seed ${seed} region ${r.id}\n${renderAscii(m, { regions: true })}`).toBe(1);
      }
    }
    expect(pockets).toBeGreaterThan(15);
  });

  it('islandCount, rims and bridgeLength are respected', () => {
    let few = 0;
    let many = 0;
    for (const seed of SWEEP.slice(0, 10)) {
      few += gen('islands', 'large', { islandCount: 4 }, seed).regions.length;
      many += gen('islands', 'large', { islandCount: 16 }, seed).regions.length;
    }
    expect(few).toBeLessThanOrEqual(40);
    expect(many).toBeGreaterThan(few * 2);
    // rims: every open tile is enclosed again
    for (const seed of SWEEP.slice(0, 10)) expect(checkMap(gen('islands', 'medium', { rims: 1 }, seed), `rims/${seed}`, false)).toEqual([]);
    // short bridges keep platforms closer: fewer bridge tiles overall
    const bridgeTiles = (len: number) =>
      SWEEP.slice(0, 10).reduce(
        (s, seed) => s + gen('islands', 'medium', { bridgeLength: len }, seed).tiles.filter((t) => t.kind === 'floor' && t.region === undefined).length,
        0,
      );
    expect(bridgeTiles(2)).toBeLessThan(bridgeTiles(20));
  });
});

describe('organic', () => {
  it('has named chambers joined by tubes and no long straight walls', () => {
    for (const seed of SWEEP.slice(0, 20)) {
      const m = gen('organic', 'large', { membranes: 0 }, seed);
      expect(m.regions.length).toBeGreaterThanOrEqual(4);
      expect(m.regions.every((r) => /chamber/.test(r.name ?? ''))).toBe(true);
      expect(m.tiles.some((t) => t.kind === 'floor' && t.region === undefined)).toBe(true); // tubes
      // blobby, not rectangular: no wall run along a row longer than 12 tiles with floor on one side
      let longest = 0;
      for (let y = 1; y < m.height - 1; y++) {
        let run = 0;
        for (let x = 0; x < m.width; x++) {
          const edge = kindAt(m, x, y) === 'wall' && (open(m, x, y - 1) || open(m, x, y + 1));
          run = edge ? run + 1 : 0;
          longest = Math.max(longest, run);
        }
      }
      expect(longest, renderAscii(m)).toBeLessThanOrEqual(12);
    }
  });

  it('chambers and tubeWidth change the layout', () => {
    let few = 0;
    let many = 0;
    let thin = 0;
    let wide = 0;
    for (const seed of SWEEP.slice(0, 10)) {
      few += gen('organic', 'large', { chambers: 3, membranes: 0 }, seed).regions.length;
      many += gen('organic', 'large', { chambers: 12, membranes: 0 }, seed).regions.length;
      const tube = (m: AreaMap) => m.tiles.filter((t) => t.kind === 'floor' && t.region === undefined).length;
      thin += tube(gen('organic', 'medium', { tubeWidth: 1 }, seed));
      wide += tube(gen('organic', 'medium', { tubeWidth: 4 }, seed));
    }
    expect(many).toBeGreaterThan(few * 2);
    expect(wide).toBeGreaterThan(thin);
  });
});

describe('geometric', () => {
  const NAMES: Record<number, RegExp> = { 0: /core|ring/, 1: /hexagonal cell/, 2: /triangular cell/, 3: /diamond cell/, 4: /facet/ };
  for (const variant of [0, 1, 2, 3, 4])
    it(`variant ${variant} is mirror-symmetric with symmetry 4 and names its cells`, () => {
      for (const seed of SWEEP.slice(0, 10))
        for (const size of SIZES) {
          const m = gen('geometric', size, { variant, symmetry: 4, pillars: 0 }, seed);
          expect(validateMap(m)).toEqual([]);
          expect(mirrorAgreement(m, 'x'), renderAscii(m)).toBeGreaterThan(0.95);
          expect(mirrorAgreement(m, 'y'), renderAscii(m)).toBeGreaterThan(0.95);
          expect(m.regions.some((r) => NAMES[variant].test(r.name ?? ''))).toBe(true);
        }
    });

  it('symmetry 1 breaks the mirror image of the openings', () => {
    let sym = 0;
    let free = 0;
    for (const seed of SWEEP.slice(0, 10)) {
      sym += mirrorAgreement(gen('geometric', 'large', { variant: 1, symmetry: 4, loops: 0 }, seed), 'x');
      free += mirrorAgreement(gen('geometric', 'large', { variant: 1, symmetry: 1, loops: 0 }, seed), 'x');
    }
    expect(free).toBeLessThan(sym);
  });

  it('rings knob sets the ring count; rings 0 / tessellation pick other variants', () => {
    const ringNames = (rings: number) => new Set(gen('geometric', 'large', { variant: 0, rings, spokes: 0 }, 3).regions.map((r) => r.name)).size;
    expect(ringNames(2)).toBe(2);
    expect(ringNames(5)).toBe(5);
    for (const seed of SWEEP.slice(0, 10)) {
      expect(gen('geometric', 'medium', { rings: 0 }, seed).regions.some((r) => /core|ring/.test(r.name ?? ''))).toBe(false);
      expect(gen('geometric', 'medium', { tessellation: 2 }, seed).regions.some((r) => /triangular/.test(r.name ?? ''))).toBe(true);
    }
  });

  it('doors knob puts doors between walls', () => {
    let doors = 0;
    for (const seed of SWEEP.slice(0, 10)) {
      const m = gen('geometric', 'medium', { doors: 1, variant: 0 }, seed);
      m.tiles.forEach((t, i) => {
        if (t.kind !== 'door') return;
        doors++;
        const x = i % m.width;
        const y = (i - x) / m.width;
        const solid = (dx: number, dy: number) => ['wall', 'void'].includes(kindAt(m, x + dx, y + dy));
        expect((solid(0, -1) && solid(0, 1)) || (solid(-1, 0) && solid(1, 0))).toBe(true);
      });
    }
    expect(doors).toBeGreaterThan(10);
  });
});

describe('ASCII snapshots (seed 1, medium)', () => {
  for (const g of NEW_GENS)
    it(g, () => {
      expect(renderAscii(gen(g, 'medium', {}, 1), { regions: true })).toMatchSnapshot();
    });
});
