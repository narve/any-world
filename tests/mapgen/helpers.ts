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

/** generators whose platforms end directly at the void (no wall rim) by default */
export const OPEN_EDGED: ReadonlySet<string> = new Set(['islands']);

export function checkMap(map: AreaMap, label: string, openEdges = false): string[] {
  const problems: string[] = [];
  const W = map.width;
  const H = map.height;
  const at = (x: number, y: number) => map.tiles[y * W + x];
  // start / exit
  if (map.start.x === map.exit.x && map.start.y === map.exit.y) problems.push('start == exit');
  if (at(map.start.x, map.start.y).kind !== 'start') problems.push('start tile kind');
  if (at(map.exit.x, map.exit.y).kind !== 'transition') problems.push('exit tile kind');
  // connectivity: exit reachable and every passable tile reachable
  const r = reachable(map, map.start);
  if (!r.has(map.exit.y * W + map.exit.x)) problems.push('exit not reachable');
  if (r.size !== passableCount(map)) problems.push(`unreachable passable tiles: ${passableCount(map) - r.size}`);
  // closed border
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (PASSABLE_KINDS.has(at(x, y).kind) || at(x, y).kind === 'water') problems.push(`border ${x},${y}`);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (PASSABLE_KINDS.has(at(x, y).kind) || at(x, y).kind === 'water') problems.push(`border ${x},${y}`);
  // every passable tile is enclosed: no passable tile touches void (floating layouts excepted)
  if (!openEdges)
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        if (!PASSABLE_KINDS.has(at(x, y).kind)) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy).kind === 'void') problems.push(`open tile ${x},${y} touches void`);
      }
  // far apart
  const d = Math.hypot(map.start.x - map.exit.x, map.start.y - map.exit.y);
  if (d < 0.4 * Math.hypot(W, H)) problems.push(`start/exit too close (${d.toFixed(1)})`);
  // regions
  if (map.regions.length < 2) problems.push(`only ${map.regions.length} regions`);
  map.regions.forEach((rg, i) => {
    if (rg.id !== i) problems.push(`region id ${rg.id} at index ${i}`);
    if (rg.size <= 0) problems.push(`region ${i} empty`);
    const c = at(rg.centre.x, rg.centre.y);
    if (c.region !== rg.id) problems.push(`region ${i} centre not inside region`);
  });
  for (const t of map.tiles) if (t.region !== undefined && (t.region < 0 || t.region >= map.regions.length)) problems.push('tile region out of range');
  // the playable shape uses a decent share of the map
  if (passableCount(map) < W * H * 0.15) problems.push(`too little floor (${passableCount(map)})`);
  return problems.slice(0, 5).map((p) => `${label}: ${p}`);
}
