/**
 * Builds the example places bundled with the client (content/places/<id>.json) from the recorded
 * fixtures (tests/fixtures/osm): the picker offers them without asking the map service.
 *   npx tsx tools/place-bundle.ts domkirken placa-reial
 * Not tangen, kkg and kuben: those are district-scale patches built from a wider fetch (docs/PLACE-PLAN.md §11);
 * this tool would replace them with street-scale ones.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildPatch } from '../src/place/patch';
import { placeId } from '../src/place/load';

mkdirSync('content/places', { recursive: true });
for (const id of process.argv.slice(2)) {
  const fx = JSON.parse(readFileSync(`tests/fixtures/osm/${id}.json`, 'utf8'));
  const patch = buildPatch(fx.elements, { id: placeId(fx.name), name: fx.name, lat: fx.lat, lon: fx.lon, extent: fx.extent });
  const out = { name: fx.name, displayName: fx.displayName, lat: fx.lat, lon: fx.lon, type: '', patch };
  writeFileSync(`content/places/${id}.json`, `${JSON.stringify(out)}\n`);
  console.log(`content/places/${id}.json: ${patch.features.length} features, ${(JSON.stringify(out).length / 1024).toFixed(1)} KB`);
}
