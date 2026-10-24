import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERATOR_NAMES,
  applyAreaTerrain,
  distanceField,
  findPlacement,
  generateArea,
  posKey,
  renderAscii,
  scatterTerrain,
  seededRng,
  validateMap,
  type PlacementWhere,
} from '../../src/engine/mapgen';
import { WorldSpec } from '../../src/schema/world';
import { emptyWorld, makePlan, passableCount, reachable } from './helpers';

const WHERES: PlacementWhere[] = ['anywhere', 'near_start', 'near_exit', 'far', 'centre', 'guarded'];

describe('findPlacement', () => {
  for (const gen of GENERATOR_NAMES) {
    it(`${gen}: returns reachable free floor tiles for every placement kind`, () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const map = generateArea(makePlan(gen), emptyWorld, seededRng(seed));
        const rng = seededRng(seed + 100);
        const occupied = new Set<string>([posKey(map.start), posKey(map.exit)]);
        const reach = reachable(map, map.start);
        const dStart = distanceField(map, map.start);
        const dExit = distanceField(map, map.exit);
        let maxD = 0;
        for (const d of dStart) if (d > maxD) maxD = d;
        for (const where of WHERES) {
          for (let k = 0; k < 3; k++) {
            const p = findPlacement(map, where, rng, occupied);
            expect(p, `${gen}/${seed}/${where}`).not.toBeNull();
            const i = p!.y * map.width + p!.x;
            expect(map.tiles[i].kind).toBe('floor');
            expect(reach.has(i)).toBe(true);
            expect(occupied.has(posKey(p!))).toBe(false);
            if (where === 'near_start') expect(dStart[i]).toBeLessThanOrEqual(8);
            if (where === 'near_exit') expect(dExit[i]).toBeLessThanOrEqual(8);
            if (where === 'far' || where === 'guarded') expect(dStart[i]).toBeGreaterThanOrEqual(Math.floor(maxD * 0.45));
            occupied.add(posKey(p!));
          }
        }
      }
    });
  }

  it('centre picks tiles near the middle of the playable shape', () => {
    const map = generateArea(makePlan('arena', 'large'), emptyWorld, seededRng(3));
    const p = findPlacement(map, 'centre', seededRng(1), new Set())!;
    expect(Math.abs(p.x - map.width / 2)).toBeLessThan(map.width * 0.2);
    expect(Math.abs(p.y - map.height / 2)).toBeLessThan(map.height * 0.2);
  });

  it('returns null when every tile is occupied', () => {
    const map = generateArea(makePlan('rooms', 'small'), emptyWorld, seededRng(1));
    const occ = new Set<string>();
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) occ.add(`${x},${y}`);
    expect(findPlacement(map, 'anywhere', seededRng(1), occ)).toBeNull();
  });

  it('is deterministic', () => {
    const map = generateArea(makePlan('caves'), emptyWorld, seededRng(8));
    const a = WHERES.map((w) => findPlacement(map, w, seededRng(5), new Set()));
    const b = WHERES.map((w) => findPlacement(map, w, seededRng(5), new Set()));
    expect(b).toEqual(a);
  });
});

describe('scatterTerrain', () => {
  for (const gen of GENERATOR_NAMES) {
    it(`${gen}: blocking terrain never disconnects the map, even at high density`, () => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const map = generateArea(makePlan(gen), emptyWorld, seededRng(seed));
        const before = passableCount(map);
        const rng = seededRng(seed * 3);
        const placedA = scatterTerrain(map, { id: 'boulder', walkable: false }, 0.3, rng);
        const placedB = scatterTerrain(map, 'crate', 0.3, rng, new Set(['boulder']));
        expect(placedA.length).toBeGreaterThan(0);
        const blocked = new Set(['boulder', 'crate']);
        const reach = reachable(map, map.start, blocked);
        expect(reach.has(map.exit.y * map.width + map.exit.x), `${gen}/${seed}\n${renderAscii(map)}`).toBe(true);
        let open = 0;
        for (const t of map.tiles) if (['floor', 'door', 'door_open', 'start', 'transition'].includes(t.kind) && !(t.terrain && blocked.has(t.terrain))) open++;
        expect(reach.size).toBe(open);
        expect(open).toBe(before - placedA.length - placedB.length);
        for (const p of [...placedA, ...placedB]) {
          expect(map.tiles[p.y * map.width + p.x].kind).toBe('floor');
          expect(Math.max(Math.abs(p.x - map.start.x), Math.abs(p.y - map.start.y))).toBeGreaterThan(1);
        }
      }
    });
  }

  it('walkable terrain is scattered freely at the requested density', () => {
    const map = generateArea(makePlan('open', 'medium'), emptyWorld, seededRng(2));
    const floors = map.tiles.filter((t) => t.kind === 'floor').length;
    const placed = scatterTerrain(map, { id: 'grass', walkable: true }, 0.2, seededRng(3));
    expect(placed.length).toBeGreaterThan(floors * 0.15);
    expect(placed.length).toBeLessThanOrEqual(Math.round(floors * 0.2) + 1);
    expect(new Set(placed.map(posKey)).size).toBe(placed.length);
  });

  it('density 0 places nothing', () => {
    const map = generateArea(makePlan('rooms'), emptyWorld, seededRng(2));
    expect(scatterTerrain(map, 'x', 0, seededRng(1))).toEqual([]);
  });
});

describe('fixture worlds', () => {
  const dir = join(__dirname, '../../content/worlds');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    it(`${f}: every area generates a valid map with terrain applied`, () => {
      const world = WorldSpec.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      const blocked = new Set(world.terrains.filter((t) => !t.walkable).map((t) => t.id));
      world.areas.forEach((area, i) => {
        for (const seed of [1, 2, 3, 4, 5]) {
          const rng = seededRng(seed);
          const map = generateArea(area, world, rng);
          expect(validateMap(map), `${f} area ${i}`).toEqual([]);
          applyAreaTerrain(map, area, world, rng);
          const reach = reachable(map, map.start, blocked);
          expect(reach.has(map.exit.y * map.width + map.exit.x), `${f} area ${i} seed ${seed}`).toBe(true);
          for (const where of ['near_start', 'far', 'guarded', 'centre'] as const)
            expect(findPlacement(map, where, rng, new Set(), { blockedTerrain: blocked })).not.toBeNull();
        }
      });
    });
  }
});
