/**
 * Map generation entry point. OWNED BY the mapgen builder (M1) — this is a placeholder stub.
 * Contract: generateArea(plan, world, rng) → AreaMap, deterministic for a given rng state,
 * start and exit always connected by walkable tiles.
 */
import type { AreaMap, MapGenerator } from '../types';

export const generateArea: MapGenerator = (): AreaMap => {
  throw new Error('mapgen not implemented yet');
};
