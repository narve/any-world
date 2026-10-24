/**
 * Validate World Spec JSON files (zod shape + cross references).
 *
 *   npx tsx tools/validate-worlds.ts                 # all content/worlds/*.json
 *   npx tsx tools/validate-worlds.ts a.json b.json   # specific files
 *   npx tsx tools/validate-worlds.ts --loose         # allow unknown (ignored) keys
 *
 * Exits 1 if any file fails.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorld } from '../src/schema/refs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listDefault(): string[] {
  const dir = join(root, 'content', 'worlds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

function summarize(world: { meta: { title: string }; areas: unknown[]; actors: unknown[]; items: unknown[] }): string {
  return `"${world.meta.title}" — ${world.areas.length} areas, ${world.actors.length} actors, ${world.items.length} items`;
}

const argv = process.argv.slice(2);
const loose = argv.includes('--loose');
const args = argv.filter((a) => a !== '--loose');
const files = args.length ? args.map((a) => resolve(a)) : listDefault();
if (!files.length) {
  console.error('No world files found.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    failed++;
    console.log(`FAIL ${file}\n  cannot read/parse JSON: ${(e as Error).message}`);
    continue;
  }
  const res = parseWorld(json, { strictKeys: !loose });
  if (res.ok) {
    console.log(`ok   ${file}  ${summarize(res.world)}`);
  } else {
    failed++;
    console.log(`FAIL ${file}  (${res.errors.length} error${res.errors.length === 1 ? '' : 's'})`);
    for (const err of res.errors) console.log(`  - ${err}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} valid`);
process.exit(failed ? 1 : 0);
