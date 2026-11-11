/**
 * A recorded place (tests/fixtures/osm/<id>.json) as the `place` generator lays it out, in ASCII:
 *   npx tsx tools/place-ascii.ts torvet [seed] [small|medium|large] [--party 4] [--names]
 * Ground marks: = road, : path, " grass, _ plaza, T tree; buildings as walls (#) with doors (+).
 */
import { readFileSync } from 'node:fs';
import { generateArea, seededRng, validateMap } from '../src/engine/mapgen';
import { buildPatch } from '../src/place/patch';
import type { AreaPlan, WorldSpec } from '../src/schema/world';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const id = args[0] ?? 'torvet';
const seed = Number(args[1] ?? 1);
const size = (args[2] ?? 'large') as AreaPlan['size'];
const pi = process.argv.indexOf('--party');
const partySize = pi === -1 ? 1 : Number(process.argv[pi + 1]);
// --bundled: an example place of content/places (already a built patch)
const bundled = process.argv.includes('--bundled');
const fx = JSON.parse(readFileSync(bundled ? `content/places/${id}.json` : `tests/fixtures/osm/${id}.json`, 'utf8'));
const patch = bundled ? fx.patch : buildPatch(fx.elements, { id, name: fx.name, lat: fx.lat, lon: fx.lon, extent: fx.extent });
const plan = { name: fx.name, generator: 'place', patch: patch.id, size, params: {}, lighting: {} } as unknown as AreaPlan;
const world = { place: { patches: [patch] } } as unknown as WorldSpec;
const t0 = performance.now();
const map = generateArea(plan, world, seededRng(seed), { partySize });
const ms = performance.now() - t0;
const regions = process.argv.includes('--regions');
const CH: Record<string, string> = { wall: '#', door: '+', void: ' ', water: '~', transition: '>', start: '<' };
const SURF: Record<string, string> = { road: '=', path: ':', grass: '"', plaza: '_', rail: '%', pavement: ',' };
for (let y = 0; y < map.height; y++) {
  let line = '';
  for (let x = 0; x < map.width; x++) {
    const t = map.tiles[y * map.width + x]!;
    const named = regions && t.region !== undefined && t.region > 0 && !t.surface ? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSUVWXYZ'[t.region % 51] : undefined;
    line += t.prop === 'tree' ? 'T' : t.kind === 'floor' ? (t.surface ? SURF[t.surface] : named ?? '.') : CH[t.kind] ?? '?';
  }
  console.log(line);
}
console.log(`${fx.name}: ${map.width}×${map.height}, ${ms.toFixed(1)} ms, problems: ${validateMap(map).join('; ') || 'none'}`);
if (process.argv.includes('--names')) console.log(map.regions.filter((r) => r.name).map((r) => `${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSUVWXYZ'[r.id % 51]}=${r.name} (${r.size})`).join(', '));
