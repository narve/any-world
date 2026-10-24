/** World registry: GameState refers to its world by id (the spec itself is not stored in saves). */
import type { WorldSpec } from '../schema/world';
import type { GameState } from './types';
import { hashString } from './util';

// ---------------------------------------------------------------------------
// World registry
// ---------------------------------------------------------------------------

export const registry = new Map<string, WorldSpec>();
const idCache = new WeakMap<WorldSpec, string>();

export function worldIdOf(world: WorldSpec): string {
  const hit = idCache.get(world);
  if (hit) return hit;
  const slug = world.meta.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = `${slug || 'world'}-${hashString(JSON.stringify(world))}`;
  idCache.set(world, id);
  return id;
}

export function registerWorld(world: WorldSpec): string {
  const id = worldIdOf(world);
  registry.set(id, world);
  return id;
}

export function getWorld(stateOrId: GameState | string): WorldSpec | undefined {
  return registry.get(typeof stateOrId === 'string' ? stateOrId : stateOrId.worldId);
}

