/**
 * Print an ASCII render of a generated map.
 *
 *   npx tsx tools/mapgen-ascii.ts <generator|all> [seed] [small|medium|large] [options]
 *   npx tsx tools/mapgen-ascii.ts --world content/worlds/fixture-ship.json --area 0 [seed]
 *
 * Options:
 *   --params k=v,k=v   generator knobs (e.g. roomCount=12,openness=0.3)
 *   --lamps <0..1>     lamp frequency (default 0.08)
 *   --regions          show region ids on floor tiles
 *   --names            list the regions (id, name, size, centre) under the map
 *   --terrain          also scatter the area's terrain (with --world)
 *   --stats            print timing and region/door counts
 *
 * Legend: # wall  . floor  + door  < start  > exit  ~ water  * lamp  (space) void
 * (islands platforms end directly at the void unless params rims=1)
 *
 * Generator knobs are documented at the top of each file in src/engine/mapgen/generators/.
 * Examples:
 *   npx tsx tools/mapgen-ascii.ts islands 3 large --params islandCount=14,pockets=1 --regions --names
 *   npx tsx tools/mapgen-ascii.ts organic 5 medium --params chambers=4,curl=1,membranes=1
 *   npx tsx tools/mapgen-ascii.ts geometric 7 medium --params variant=0,rings=4,spokes=8
 */
import { readFileSync } from 'node:fs';
import type { AreaPlan, WorldSpec } from '../src/schema/world';
import { GENERATOR_NAMES, applyAreaTerrain, generateArea, renderAscii, seededRng, validateMap } from '../src/engine/mapgen';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (!['--regions', '--names', '--terrain', '--stats', '--help'].includes(args[i])) i++;
    continue;
  }
  positional.push(args[i]);
}

if (flag('--help') || (!positional.length && !opt('--world'))) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

function basePlan(generator: AreaPlan['generator'], size: AreaPlan['size'], params: Record<string, number>, lamps: number): AreaPlan {
  return {
    name: generator,
    description: '',
    generator,
    size,
    params,
    floor: { color: '#888888', material: 'stone', pattern: 'plain' },
    wall: { color: '#444444', material: 'stone', pattern: 'plain' },
    lighting: { ambient: '#ffffff', ambientIntensity: 0.4, playerLight: 4, lamps: { color: '#ffcc88', intensity: 1, frequency: lamps, flicker: false } },
    actors: [],
    placed: [],
    items: [],
    itemCount: 0,
    placedItems: [],
    terrain: [],
    transitionName: 'Exit',
    gmNotes: '',
    music: 'explore',
  } as AreaPlan;
}

const params: Record<string, number> = {};
for (const kv of (opt('--params') ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  params[k.trim()] = Number(v);
}
const lamps = Number(opt('--lamps') ?? 0.08);

let world: WorldSpec | null = null;
const jobs: { label: string; plan: AreaPlan; seed: number }[] = [];
const worldPath = opt('--world');
if (worldPath) {
  world = JSON.parse(readFileSync(worldPath, 'utf8')) as WorldSpec;
  const seed = Number(positional[0] ?? 1);
  const areaArg = opt('--area');
  const indices = areaArg === undefined ? world.areas.map((_, i) => i) : [Number(areaArg)];
  for (const i of indices) {
    const a = world.areas[i];
    if (!a) throw new Error(`no area ${i}`);
    jobs.push({ label: `${world.meta?.title ?? worldPath} — area ${i}: ${a.name} (${a.generator}, ${a.size ?? 'medium'})`, plan: { ...a, size: a.size ?? 'medium', params: a.params ?? {} }, seed });
  }
} else {
  const gen = positional[0];
  const seed = Number(positional[1] ?? 1);
  const size = (positional[2] ?? 'medium') as AreaPlan['size'];
  const gens = gen === 'all' ? GENERATOR_NAMES : [gen as AreaPlan['generator']];
  for (const g of gens) {
    if (!GENERATOR_NAMES.includes(g)) throw new Error(`unknown generator "${g}" (expected one of ${GENERATOR_NAMES.join(', ')})`);
    jobs.push({ label: `${g} seed=${seed} size=${size}`, plan: basePlan(g, size, params, lamps), seed });
  }
}

for (const job of jobs) {
  const rng = seededRng(job.seed);
  const t0 = performance.now();
  const map = generateArea(job.plan, (world ?? {}) as WorldSpec, rng);
  const ms = performance.now() - t0;
  if (flag('--terrain') && world) applyAreaTerrain(map, job.plan, world, rng);
  console.log(`== ${job.label}`);
  console.log(renderAscii(map, { regions: flag('--regions') }));
  if (flag('--names'))
    for (const r of map.regions)
      console.log(`  region ${r.id.toString(36)}: ${r.name ?? '(unnamed)'} — ${r.size} tiles, centre ${r.centre.x},${r.centre.y}`);
  if (flag('--stats')) {
    const doors = map.tiles.filter((t) => t.kind === 'door').length;
    const lampsN = map.tiles.filter((t) => t.lamp).length;
    const d = Math.hypot(map.start.x - map.exit.x, map.start.y - map.exit.y);
    const problems = validateMap(map);
    console.log(
      `${map.width}x${map.height} ${ms.toFixed(1)}ms regions=${map.regions.length} doors=${doors} lamps=${lampsN} ` +
        `start=${map.start.x},${map.start.y} exit=${map.exit.x},${map.exit.y} dist=${d.toFixed(1)} (${((d / Math.hypot(map.width, map.height)) * 100).toFixed(0)}% diag)` +
        (problems.length ? ` PROBLEMS: ${problems.join('; ')}` : ''),
    );
  }
  console.log('');
}
