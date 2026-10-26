/**
 * Map generation entry point.
 *
 * generateArea(plan, world, rng, opts?) → AreaMap. Deterministic for a given rng state. The map
 * grows with `opts.partySize` (context.ts mapDimensions; a party of one keeps MAP_SIZES). Guarantees:
 *  - start ('start' tile) and exit ('transition' tile) are distinct, walkable and connected
 *    (every passable tile is in one 4-connected component);
 *  - start and exit are far apart (≥ 40% of the map diagonal whenever the shape allows);
 *  - no passable tile on the map border; tiles outside the playable shape are 'void';
 *  - open tiles are rimmed by wall, except for floating layouts (islands) whose platforms
 *    end directly at the void;
 *  - rooms / buildings / zones are numbered in `regions` (tile.region) with centre + size, and
 *    the newer generators give them structural names ("platform", "chamber", "ring 2");
 *  - lamps (tile.lamp) according to plan.lighting.lamps.frequency.
 * Custom terrain (plan.terrain) is NOT applied here — call applyAreaTerrain / scatterTerrain.
 */
import type { AreaPlan, WorldSpec } from '../../schema/world';
import type { AreaMap, MapGenOptions, MapGenerator, Rng } from '../types';
import { makeContext, type GenContext } from './context';
import { finalize } from './finalize';
import { PASSABLE_KINDS, components } from './grid';
import { genArena } from './generators/arena';
import { genBuilding } from './generators/building';
import { genCaves } from './generators/caves';
import { genMaze } from './generators/maze';
import { genGeometric } from './generators/geometric';
import { genIslands } from './generators/islands';
import { genOpen } from './generators/open';
import { genOrganic } from './generators/organic';
import { genRooms } from './generators/rooms';
import { genShip } from './generators/ship';
import { genTown } from './generators/town';

export type GeneratorName = AreaPlan['generator'];

const GENERATORS: Record<GeneratorName, (ctx: GenContext) => void> = {
  rooms: genRooms,
  caves: genCaves,
  open: genOpen,
  town: genTown,
  building: genBuilding,
  ship: genShip,
  maze: genMaze,
  arena: genArena,
  islands: genIslands,
  organic: genOrganic,
  geometric: genGeometric,
};

export const GENERATOR_NAMES = Object.keys(GENERATORS) as GeneratorName[];

/** Problems with a finished map (empty array = valid). Used for self-checks and tests. */
export function validateMap(map: AreaMap): string[] {
  const problems: string[] = [];
  const { width: W, height: H, tiles } = map;
  if (tiles.length !== W * H) problems.push('tile count mismatch');
  const at = (p: { x: number; y: number }) => tiles[p.y * W + p.x];
  if (map.start.x === map.exit.x && map.start.y === map.exit.y) problems.push('start equals exit');
  if (!at(map.start) || at(map.start).kind !== 'start') problems.push('start tile is not kind start');
  if (!at(map.exit) || at(map.exit).kind !== 'transition') problems.push('exit tile is not kind transition');
  for (let x = 0; x < W; x++)
    for (const y of [0, H - 1]) if (PASSABLE_KINDS.has(tiles[y * W + x].kind)) problems.push(`passable border tile ${x},${y}`);
  for (let y = 0; y < H; y++)
    for (const x of [0, W - 1]) if (PASSABLE_KINDS.has(tiles[y * W + x].kind)) problems.push(`passable border tile ${x},${y}`);
  const { sizes } = components(W, H, (i) => PASSABLE_KINDS.has(tiles[i].kind));
  if (sizes.length !== 1) problems.push(`passable area split into ${sizes.length} components`);
  return problems;
}

function generateOnce(plan: AreaPlan, rng: Rng, partySize?: number): AreaMap {
  const ctx = makeContext(plan, rng, partySize);
  const gen = GENERATORS[plan.generator] ?? genRooms;
  gen(ctx);
  return finalize(ctx.g, rng, {
    lampFrequency: plan.lighting?.lamps?.frequency ?? 0,
    dropBelow: ctx.dropBelow,
    voronoi: ctx.voronoi,
    doors: ctx.carveDoors,
    openEdges: ctx.openEdges,
    regionNames: ctx.regionNames,
    pruneSpurs: ctx.pruneSpurs,
    shortcuts: ctx.shortcuts,
  });
}

export const generateArea: MapGenerator = (plan: AreaPlan, _world: WorldSpec, rng: Rng, opts?: MapGenOptions): AreaMap => {
  const partySize = opts?.partySize;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const map = generateOnce(plan, rng, partySize);
      if (validateMap(map).length === 0) return map;
      lastErr = new Error(validateMap(map).join('; '));
    } catch (e) {
      lastErr = e;
    }
  }
  // last resort: plain rooms & corridors always work
  try {
    const map = generateOnce({ ...plan, generator: 'rooms', params: {} }, rng, partySize);
    if (validateMap(map).length === 0) return map;
  } catch (e) {
    lastErr = e;
  }
  throw new Error(`mapgen failed for generator ${plan.generator}: ${String(lastErr)}`);
};

export { renderAscii, type AsciiOptions } from './ascii';
export { MAP_SIZES, mapDimensions, type MapSize } from './context';
export { PASSABLE_KINDS, isPassableKind, isPassableTile, posKey } from './grid';
export { applyAreaTerrain, distanceField, findPlacement, scatterTerrain, type PlacementOptions, type PlacementWhere } from './placement';
export { seededRng } from './rng';
