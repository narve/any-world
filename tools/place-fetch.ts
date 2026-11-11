/**
 * Fetches the OpenStreetMap data of a place and saves it as a test fixture (raw Overpass elements,
 * trimmed to the tags the patch builder reads) and prints the patch summary.
 *
 *   npx tsx tools/place-fetch.ts "Torvet, Kristiansand" --id torvet [--extent 160] [--out tests/fixtures/osm]
 *   npx tsx tools/place-fetch.ts --lat 58.1463 --lon 7.9960 --name Torvet --id torvet
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchPlace } from '../src/place/geocode';
import { fetchOsm, type OsmElement } from '../src/place/overpass';
import { buildPatch, patchRadius, patchSummary, DEFAULT_EXTENT } from '../src/place/patch';

const UA = 'anyworld-dev/0.1 (https://github.com/narve/any-world)';
const KEEP = new Set(['name', 'building', 'building:levels', 'highway', 'area', 'place', 'natural', 'water', 'waterway', 'leisure', 'landuse', 'barrier', 'railway', 'amenity', 'shop', 'tourism', 'historic', 'office', 'width', 'lanes', 'tunnel', 'location', 'indoor', 'level', 'type']);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
function trim(el: OsmElement): OsmElement {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.tags ?? {})) if (KEEP.has(k)) tags[k] = v;
  const geo = (g: OsmElement['geometry']) => g?.map((p) => (p ? { lat: r7(p.lat), lon: r7(p.lon) } : null));
  return {
    type: el.type,
    id: el.id,
    ...(Object.keys(tags).length ? { tags } : {}),
    ...(el.lat !== undefined ? { lat: r7(el.lat), lon: r7(el.lon!) } : {}),
    ...(el.geometry ? { geometry: geo(el.geometry) } : {}),
    ...(el.members ? { members: el.members.filter((m) => m.type === 'way' && m.geometry).map((m) => ({ type: m.type, role: m.role, geometry: geo(m.geometry) })) } : {}),
  } as OsmElement;
}

async function main(): Promise<void> {
  const query = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const extent = Number(arg('extent') ?? DEFAULT_EXTENT);
  let lat = Number(arg('lat'));
  let lon = Number(arg('lon'));
  let name = arg('name') ?? query ?? 'Place';
  let displayName = name;
  if (query && !(Number.isFinite(lat) && Number.isFinite(lon))) {
    const hits = await searchPlace(query, { userAgent: UA });
    if (!hits.length) throw new Error(`no place found for "${query}"`);
    ({ lat, lon, displayName } = hits[0]!);
    name = arg('name') ?? hits[0]!.name;
    console.log(`found: ${displayName} (${lat}, ${lon}) [${hits[0]!.type}]`);
  }
  const id = arg('id') ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ?? 'place';
  const elements = (await fetchOsm(lat, lon, patchRadius(extent), { userAgent: UA, timeoutMs: 60_000 })).map(trim);
  const scale = arg('scale') === 'district' ? 'district' : 'street';
  const rotation = arg('rotation') !== undefined ? Number(arg('rotation')) : undefined;
  const patch = buildPatch(elements, { id, name, lat, lon, extent, scale, ...(rotation !== undefined ? { rotation } : {}) });
  if (process.argv.includes('--bundle')) {
    // an example place bundled with the client: the built patch only, no fixture
    mkdirSync('content/places', { recursive: true });
    writeFileSync(`content/places/${id}.json`, `${JSON.stringify({ name, displayName, lat, lon, type: '', patch })}\n`);
    console.log(`content/places/${id}.json: ${patch.features.length} features, ${(JSON.stringify(patch).length / 1024).toFixed(1)} KB`);
    console.log(patchSummary(patch).landmarks.slice(0, 30).map((l) => l.name).join(', '));
    return;
  }
  const s = patchSummary(patch);
  const out = arg('out') ?? 'tests/fixtures/osm';
  mkdirSync(out, { recursive: true });
  const file = join(out, `${id}.json`);
  const text = JSON.stringify({ name, displayName, lat, lon, extent, elements });
  writeFileSync(file, text);
  console.log(`${file}: ${elements.length} elements, ${(text.length / 1024).toFixed(0)} KB raw → patch ${patch.features.length} features, ${(JSON.stringify(patch).length / 1024).toFixed(1)} KB`);
  console.log(`buildings ${s.buildings} (${s.namedBuildings} named), trees ${s.trees}, greens ${s.greens}, water ${s.water}, sparse ${s.sparse}`);
  console.log(`roads: ${s.roads.join(', ')}`);
  console.log(`landmarks: ${s.landmarks.slice(0, 14).map((l) => `${l.name}${l.type ? ` (${l.type})` : ''}`).join(', ')}`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
