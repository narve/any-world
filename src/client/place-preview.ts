/**
 * A small map of a real-place patch as the game will lay it out (docs/PLACE-PLAN.md §5): the
 * `place` generator's own tiles, drawn flat with the names of the biggest landmarks, so the player
 * can see "yes, that is my square" before creating the world.
 */
import { generateArea, seededRng } from '../engine/mapgen';
import type { AreaMap } from '../engine/types';
import type { PlacePatch } from '../schema/place';
import type { AreaPlan, WorldSpec } from '../schema/world';

/** the patch laid out as a large area (a dry run of the generator; the seed only moves doors and inner walls) */
export function previewMap(patch: PlacePatch, seed = 1): AreaMap {
  const plan = { name: patch.name, generator: 'place', patch: patch.id, size: 'large', params: {}, lighting: {} } as unknown as AreaPlan;
  const world = { place: { patches: [patch] } } as unknown as WorldSpec;
  return generateArea(plan, world, seededRng(seed));
}

export const PREVIEW_COLORS = {
  ground: '#b9b4a8',
  road: '#5b5e66',
  path: '#cdbf9f',
  pavement: '#a9a9a9',
  grass: '#6fa857',
  rail: '#6e6258',
  plaza: '#ddd6c6',
  water: '#4f8fbf',
  wall: '#4a3f3a',
  indoor: '#e9dcc3',
  door: '#b5793a',
  tree: '#2f7a2c',
  void: '#1d2026',
  start: '#ffd23f',
  label: '#14161a',
  halo: 'rgba(255,255,255,0.85)',
} as const;

/** the colour of one tile of a place map */
export function previewColor(map: AreaMap, i: number): string {
  const t = map.tiles[i]!;
  const C = PREVIEW_COLORS;
  if (t.prop === 'tree') return C.grass;
  switch (t.kind) {
    case 'wall':
      return C.wall;
    case 'void':
      return C.void;
    case 'water':
      return C.water;
    case 'door':
    case 'door_open':
      return C.door;
    default:
      break;
  }
  if (t.surface) return C[t.surface];
  // floor without a surface: indoors when its region is a building (not the ground region 0)
  return t.region !== undefined && t.region !== 0 && !isOutdoorRegion(map, t.region) ? C.indoor : C.ground;
}

const outdoorCache = new WeakMap<AreaMap, Set<number>>();
/** regions that hold surfaced tiles (streets, squares, parks) are outdoors */
function isOutdoorRegion(map: AreaMap, region: number): boolean {
  let set = outdoorCache.get(map);
  if (!set) {
    set = new Set<number>([0]);
    for (const t of map.tiles) if (t.surface && t.region !== undefined) set.add(t.region);
    outdoorCache.set(map, set);
  }
  return set.has(region);
}

export interface PreviewOptions {
  /** canvas pixels per tile (default 10) */
  scale?: number;
  /** how many names to write (default 7) */
  labels?: number;
}

/** draws the patch onto the canvas (resizing it to the map) and returns the laid-out map */
export function drawPlacePreview(canvas: HTMLCanvasElement, patch: PlacePatch, opts: PreviewOptions = {}): AreaMap {
  const map = previewMap(patch);
  const s = opts.scale ?? 10;
  canvas.width = map.width * s;
  canvas.height = map.height * s;
  const ctx = canvas.getContext('2d');
  if (!ctx) return map;
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      ctx.fillStyle = previewColor(map, i);
      ctx.fillRect(x * s, y * s, s, s);
      if (map.tiles[i]!.prop === 'tree') {
        ctx.fillStyle = PREVIEW_COLORS.tree;
        ctx.beginPath();
        ctx.arc((x + 0.5) * s, (y + 0.5) * s, s * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  // where the run starts
  ctx.fillStyle = PREVIEW_COLORS.start;
  ctx.strokeStyle = PREVIEW_COLORS.label;
  ctx.lineWidth = Math.max(1, s * 0.15);
  ctx.beginPath();
  ctx.arc((map.start.x + 0.5) * s, (map.start.y + 0.5) * s, s * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // names: the biggest named regions, skipping ones that would overlap
  const named = map.regions.filter((r) => r.name && r.id !== 0).sort((a, b) => b.size - a.size);
  const font = Math.max(9, Math.round(s * 1.15));
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const boxes: [number, number, number, number][] = [];
  let written = 0;
  for (const r of named) {
    if (written >= (opts.labels ?? 7)) break;
    const text = r.name!.length > 24 ? `${r.name!.slice(0, 23)}…` : r.name!;
    const w = ctx.measureText(text).width + 6;
    const cx = Math.min(canvas.width - w / 2 - 2, Math.max(w / 2 + 2, (r.centre.x + 0.5) * s));
    const cy = Math.min(canvas.height - font, Math.max(font, (r.centre.y + 0.5) * s));
    const box: [number, number, number, number] = [cx - w / 2, cy - font * 0.7, cx + w / 2, cy + font * 0.7];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    ctx.fillStyle = PREVIEW_COLORS.halo;
    ctx.fillRect(box[0], box[1], w, font * 1.4);
    ctx.fillStyle = PREVIEW_COLORS.label;
    ctx.fillText(text, cx, cy + 0.5);
    written++;
  }
  return map;
}
