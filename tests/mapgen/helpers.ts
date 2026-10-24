import type { AreaPlan, WorldSpec } from '../../src/schema/world';
import type { AreaMap } from '../../src/engine/types';
import { PASSABLE_KINDS } from '../../src/engine/mapgen';

export function makePlan(
  generator: AreaPlan['generator'],
  size: AreaPlan['size'] = 'medium',
  params: Record<string, number> = {},
  lampFrequency = 0.08,
): AreaPlan {
  return {
    name: `test ${generator}`,
    description: '',
    generator,
    size,
    params,
    floor: { color: '#888888', material: 'stone', pattern: 'plain' },
    wall: { color: '#444444', material: 'stone', pattern: 'plain' },
    lighting: {
      ambient: '#ffffff',
      ambientIntensity: 0.4,
      playerLight: 4,
      lamps: lampFrequency > 0 ? { color: '#ffcc88', intensity: 1, frequency: lampFrequency, flicker: false } : undefined,
    },
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

export const emptyWorld = { terrains: [] } as unknown as WorldSpec;

/** set of tile indices reachable (4-way) from p over passable tiles, honouring blocked terrain */
export function reachable(map: AreaMap, from: { x: number; y: number }, blocked: ReadonlySet<string> = new Set()): Set<number> {
  const W = map.width;
  const seen = new Set<number>([from.y * W + from.x]);
  const stack = [from.y * W + from.x];
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % W;
    const y = (c - x) / W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue;
      const n = ny * W + nx;
      const t = map.tiles[n];
      if (seen.has(n) || !PASSABLE_KINDS.has(t.kind)) continue;
      if (t.terrain && blocked.has(t.terrain)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

export function passableCount(map: AreaMap): number {
  return map.tiles.filter((t) => PASSABLE_KINDS.has(t.kind)).length;
}
