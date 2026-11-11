import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAP_SIZES, generateArea, mapDimensions, renderAscii, seededRng, validateMap } from '../../src/engine/mapgen';
import type { AreaMap } from '../../src/engine/types';
import { PlacePatch as PlacePatchSchema } from '../../src/schema/place';
import type { PlacePatch } from '../../src/schema/place';
import type { WorldSpec } from '../../src/schema/world';
import { PLACE_FIXTURES, fixturePatch } from '../place/fixtures';
import { checkMap, cpuMs, makePlan } from './helpers';

const SIZES = ['small', 'medium', 'large'] as const;
const SEEDS = Array.from({ length: 50 }, (_, i) => i * 7919 + 1);

const worldWith = (patch: PlacePatch) => ({ terrains: [], place: { patches: [patch] } }) as unknown as WorldSpec;
const planFor = (patch: PlacePatch, size: (typeof SIZES)[number] = 'large') => ({ ...makePlan('place', size), patch: patch.id });
const gen = (patch: PlacePatch, seed = 1, size: (typeof SIZES)[number] = 'large', partySize?: number): AreaMap =>
  generateArea(planFor(patch, size), worldWith(patch), seededRng(seed), partySize ? { partySize } : undefined);

/** like renderAscii, with the ground kinds and trees */
function ascii(map: AreaMap): string {
  const SURF: Record<string, string> = { road: '=', path: ':', grass: '"', plaza: '_', rail: '%', pavement: '.' };
  const KIND: Record<string, string> = { wall: '#', door: '+', void: ' ', water: '~', transition: '>', start: '<' };
  const lines: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let line = '';
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[y * map.width + x]!;
      line += t.prop === 'tree' ? 'T' : t.kind === 'floor' ? (t.surface ? SURF[t.surface] : ',') : KIND[t.kind] ?? '?';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

describe('place generator on recorded places', () => {
  for (const id of PLACE_FIXTURES) {
    const patch = fixturePatch(id);
    for (const size of SIZES) {
      it(`${id} / ${size}: invariants over ${SEEDS.length} seeds`, () => {
        const problems: string[] = [];
        const times: number[] = [];
        for (const seed of SEEDS) {
          let map!: AreaMap;
          times.push(cpuMs(() => (map = gen(patch, seed, size))));
          expect(map.width).toBe(MAP_SIZES[size].width);
          expect(map.height).toBe(MAP_SIZES[size].height);
          problems.push(...validateMap(map).map((p) => `${id}/${size}/${seed}: ${p}`));
          const pr = checkMap(map, `${id}/${size}/${seed}`);
          if (pr.length && problems.length < 3) problems.push(renderAscii(map));
          problems.push(...pr);
        }
        expect(problems).toEqual([]);
        times.sort((a, b) => a - b);
        expect(times[Math.floor(times.length / 2)]).toBeLessThan(50);
        expect(times[times.length - 2]).toBeLessThan(150);
      });
    }

    it(`${id}: deterministic, and the layout is the place whatever the seed`, () => {
      expect(JSON.stringify(gen(patch, 5))).toBe(JSON.stringify(gen(patch, 5)));
      // seeds move doors, inner walls and the exit; streets, water and trees stay where they are
      const fixed = (m: AreaMap) => m.tiles.map((t) => (t.kind === 'water' ? '~' : t.prop === 'tree' ? 'T' : t.surface === 'road' ? '=' : t.surface === 'grass' ? '"' : t.surface === 'plaza' ? '_' : ' ')).join('');
      expect(fixed(gen(patch, 1))).toBe(fixed(gen(patch, 99)));
    });

    it(`${id}: layout snapshot`, () => {
      expect(ascii(gen(patch, 1))).toMatchSnapshot();
    });
  }

  it('streets, squares, parks and buildings carry their real names', () => {
    const names = gen(fixturePatch('domkirken')).regions.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Kristiansand domkirke', 'Kirkegata', 'Rådhusgata', 'Gyldenløves gate', 'Nedre torv', 'Wergelandsparken']));
    const barcelona = gen(fixturePatch('placa-reial')).regions.map((r) => r.name);
    expect(barcelona).toEqual(expect.arrayContaining(['Plaça Reial', 'La Rambla']));
  });

  it('marks the ground and plants the trees', () => {
    const map = gen(fixturePatch('domkirken'));
    const count = (f: (t: AreaMap['tiles'][number]) => boolean) => map.tiles.filter(f).length;
    expect(count((t) => t.surface === 'road')).toBeGreaterThan(60);
    expect(count((t) => t.surface === 'grass')).toBeGreaterThan(60);
    expect(count((t) => t.surface === 'plaza')).toBeGreaterThan(60);
    expect(count((t) => t.prop === 'tree')).toBeGreaterThan(3);
    for (const t of map.tiles) if (t.prop === 'tree') expect(t.kind).toBe('wall');
    expect(count((t) => t.kind === 'door')).toBeGreaterThan(5);
    // the sea at Tangen, the square in Barcelona
    expect(gen(fixturePatch('tangen')).tiles.filter((t) => t.kind === 'water').length).toBeGreaterThan(200);
    expect(gen(fixturePatch('placa-reial')).tiles.filter((t) => t.surface === 'plaza').length).toBeGreaterThan(400);
  });

  it('starts outdoors near the middle and leaves along a street', () => {
    for (const id of ['domkirken', 'torvet', 'placa-reial'] as const) {
      for (const seed of SEEDS.slice(0, 10)) {
        const map = gen(fixturePatch(id), seed);
        const at = (p: { x: number; y: number }) => map.tiles[p.y * map.width + p.x]!;
        expect(at(map.start).surface, `${id}/${seed} start`).toBeDefined();
        expect(['road', 'path'], `${id}/${seed} exit`).toContain(at(map.exit).surface);
        expect(Math.hypot(map.start.x - map.width / 2, map.start.y - map.height / 2), `${id}/${seed}`).toBeLessThan(18);
      }
    }
  });

  it('the sea lies on the right-hand side of a coastline', () => {
    // a coast running west to east through the middle keeps the land on its left (north)
    const patch: PlacePatch = {
      id: 'coast',
      name: 'Coast',
      kind: 'outdoor',
      centre: { lat: 58, lon: 8 },
      extent: 160,
      rotation: 0,
      scale: 'street',
      features: [
        { kind: 'water', type: 'coastline', geometry: [-83, 10, 0, 14, 83, 10] },
        { kind: 'road', name: 'Strandveien', type: 'residential', width: 6, geometry: [-83, -20, 83, -20] },
        { kind: 'building', name: 'Naustet', geometry: [-20, -50, 10, -50, 10, -35, -20, -35] },
        { kind: 'path', type: 'footway', width: 2, geometry: [0, -20, 0, 40] },
      ],
    };
    const map = gen(patch);
    const W = map.width;
    const kind = (x: number, y: number) => map.tiles[y * W + x]!.kind;
    expect(kind(10, 30)).toBe('water');
    expect(kind(45, 34)).toBe('water');
    expect(kind(10, 8)).toBe('floor');
    // the path out over the water is a pier
    expect(kind(28, 30)).not.toBe('water');
    expect(map.tiles.filter((t) => t.kind === 'water').length).toBeGreaterThan(500);
    expect(validateMap(map)).toEqual([]);
    // a coastline with a hole in it floods nothing
    const leaky: PlacePatch = { ...patch, features: [{ kind: 'water', type: 'coastline', geometry: [-83, 10, -10, 12] }, ...patch.features.slice(1)] };
    expect(gen(leaky).tiles.filter((t) => t.kind === 'water').length).toBe(0);
  });

  it('doors sit between walls', () => {
    for (const id of PLACE_FIXTURES) {
      const map = gen(fixturePatch(id), 3);
      const W = map.width;
      map.tiles.forEach((t, i) => {
        if (t.kind !== 'door') return;
        const x = i % W;
        const y = (i - x) / W;
        const solid = (dx: number, dy: number) => ['wall', 'void', 'door'].includes(map.tiles[(y + dy) * W + x + dx]!.kind);
        expect((solid(0, -1) && solid(0, 1)) || (solid(-1, 0) && solid(1, 0)), `${id} door at ${x},${y}\n${renderAscii(map)}`).toBe(true);
      });
    }
  });

  it('a party gets the same ground on a finer grid; smaller sizes show the middle', () => {
    const patch = fixturePatch('domkirken');
    for (const n of [4, 12]) {
      const map = gen(patch, 7, 'large', n);
      expect([map.width, map.height]).toEqual(Object.values(mapDimensions('large', n)));
      expect(validateMap(map)).toEqual([]);
      expect(checkMap(map, `party ${n}`)).toEqual([]);
      expect(map.regions.map((r) => r.name)).toContain('Kristiansand domkirke');
    }
    // metres per tile stay the same from large to small: the road is as wide in tiles
    const roadShare = (m: AreaMap) => m.tiles.filter((t) => t.surface === 'road').length / (m.width * m.height);
    expect(Math.abs(roadShare(gen(patch, 1, 'small')) - roadShare(gen(patch, 1, 'large')))).toBeLessThan(0.08);
  });

  it('a bundled district place with a focus: arrive by a street, the way on is inside that building', () => {
    const file = JSON.parse(readFileSync('content/places/kkg.json', 'utf8')) as { world?: string; patch: unknown };
    const patch = PlacePatchSchema.parse(file.patch);
    expect(file.world).toBe('nb-kkg-talen');
    expect(patch.scale).toBe('district');
    expect(patch.focus).toBe('Kristiansand katedralskole Gimle');
    for (const seed of SEEDS.slice(0, 20)) {
      const map = gen(patch, seed);
      expect(validateMap(map)).toEqual([]);
      const school = map.regions.filter((r) => r.name === patch.focus).sort((a, b) => b.size - a.size)[0]!;
      expect(school.size).toBeGreaterThan(30);
      expect(Math.hypot(map.exit.x - school.centre.x, map.exit.y - school.centre.y)).toBeLessThan(12);
      const start = map.tiles[map.start.y * map.width + map.start.x]!;
      expect(['road', 'path']).toContain(start.surface);
      expect(Math.hypot(map.start.x - map.exit.x, map.start.y - map.exit.y)).toBeGreaterThan(15);
    }
  });

  it('without its patch the area falls back to a town', () => {
    const plan = { ...makePlan('place'), patch: 'missing' };
    const map = generateArea(plan, { terrains: [] } as unknown as WorldSpec, seededRng(1));
    expect(validateMap(map)).toEqual([]);
    expect(map.tiles.some((t) => t.surface !== undefined)).toBe(false);
  });
});
