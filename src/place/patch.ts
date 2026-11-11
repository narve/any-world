/**
 * Raw OpenStreetMap elements → a PlacePatch (docs/PLACE-PLAN.md §3): projection to local metres,
 * classification, clipping to the patch square, simplification and caps. Pure: no network, no
 * clock, deterministic for the same input.
 */
import type { PlaceFeature, PlacePatch } from '../schema/place';
import type { OsmElement, OsmLatLon } from './overpass';

type Pt = [number, number];

export interface PatchOptions {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** metres across (default 160) */
  extent?: number;
  /** degrees to turn the ground; default: whatever lines the house walls up with the tile grid */
  rotation?: number;
  /** 'district': a neighbourhood drawn like a tourist map (PlacePatch.scale) */
  scale?: 'street' | 'district';
}

export const DEFAULT_EXTENT = 160;
/** the Overpass radius that covers a square patch of `extent` metres, with a margin */
export function patchRadius(extent = DEFAULT_EXTENT): number {
  return Math.ceil((extent / 2) * Math.SQRT2 + 12);
}

const MAX_FEATURES = 600;
const MAX_POINTS = 200;

// --- projection --------------------------------------------------------------------------------

/** equirectangular around the centre: fine for a few hundred metres */
export function projector(lat0: number, lon0: number): (p: OsmLatLon) => Pt {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  return (p) => [(p.lon - lon0) * kx, -(p.lat - lat0) * ky];
}

/** the coordinate of a point given in patch metres (of a patch turned by `rotation` degrees) */
export function unproject(lat0: number, lon0: number, x: number, y: number, rotation = 0): OsmLatLon {
  const a = (rotation * Math.PI) / 180;
  const ux = x * Math.cos(a) - y * Math.sin(a);
  const uy = x * Math.sin(a) + y * Math.cos(a);
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
  return { lat: lat0 - uy / 110_540, lon: lon0 + ux / kx };
}

/**
 * The angle (degrees, −45 < a ≤ 45) that most house walls (and, without houses, streets) make with
 * the axes, weighted by length: turning the ground back by it lines them up with the tile grid, so
 * a town laid out at 30° to north does not become a map of zigzag walls. Only what lies within
 * `reach` metres of the centre counts, so the place the player asked for is the one that lines up.
 */
export function dominantAngle(elements: readonly OsmElement[], project: (p: OsmLatLon) => Pt, reach: number): number {
  const bins = new Float64Array(90);
  const add = (pts: Pt[], weight: number) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      if (Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by)) > reach) continue;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 2) continue;
      const deg = ((Math.atan2(by - ay, bx - ax) * 180) / Math.PI + 360) % 90;
      bins[Math.round(deg) % 90]! += len * weight;
    }
  };
  for (const el of elements) {
    const tags = el.tags ?? {};
    const building = !!tags.building && tags.building !== 'no';
    if (!building && !tags.highway) continue;
    const ways = el.type === 'way' ? [el.geometry ?? []] : (el.members ?? []).filter((m) => m.type === 'way').map((m) => m.geometry ?? []);
    for (const w of ways) add(w.filter((p): p is OsmLatLon => !!p).map(project), building ? 1 : 0.35);
  }
  let best = 0;
  let bestV = 0;
  for (let d = 0; d < 90; d++) {
    // a 5° window, so a peak split over two bins still wins
    let v = 0;
    for (let k = -2; k <= 2; k++) v += bins[(d + k + 90) % 90]! * (3 - Math.abs(k));
    if (v > bestV) {
      bestV = v;
      best = d;
    }
  }
  if (bestV === 0) return 0;
  // refine inside the window: the weighted mean of the neighbouring bins
  let sw = 0;
  let sa = 0;
  for (let k = -2; k <= 2; k++) {
    const w = bins[(best + k + 90) % 90]!;
    sw += w;
    sa += w * (best + k);
  }
  const a = sw ? sa / sw : best;
  const turned = ((a % 90) + 90) % 90;
  return Math.round((turned > 45 ? turned - 90 : turned) * 10) / 10;
}

// --- geometry ----------------------------------------------------------------------------------

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i]!;
    const [x2, y2] = r[(i + 1) % r.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function centroid(r: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of r) {
    sx += x;
    sy += y;
  }
  return [sx / r.length, sy / r.length];
}

export function pointInRing(x: number, y: number, r: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Sutherland–Hodgman: a ring clipped to the square |x|,|y| ≤ h */
function clipRing(ring: Pt[], h: number): Pt[] {
  let out = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= -h, (a, b) => [-h, a[1] + ((b[1] - a[1]) * (-h - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= h, (a, b) => [h, a[1] + ((b[1] - a[1]) * (h - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= -h, (a, b) => [a[0] + ((b[0] - a[0]) * (-h - a[1])) / (b[1] - a[1]), -h]],
    [(p) => p[1] <= h, (a, b) => [a[0] + ((b[0] - a[0]) * (h - a[1])) / (b[1] - a[1]), h]],
  ];
  for (const [inside, cross] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i]!;
      const b = src[(i + 1) % src.length]!;
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    if (out.length < 3) return [];
  }
  return out;
}

/** a line clipped to the square |x|,|y| ≤ h: the pieces inside it */
function clipLine(line: Pt[], h: number): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [x0, y0] = line[i]!;
    const [x1, y1] = line[i + 1]!;
    // Liang–Barsky
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0 + h], [dx, h - x0], [-dy, y0 + h], [dy, h - y0]] as [number, number][]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
      continue;
    }
    const a: Pt = [x0 + dx * t0, y0 + dy * t0];
    const b: Pt = [x0 + dx * t1, y0 + dy * t1];
    if (cur.length === 0) cur.push(a);
    cur.push(b);
    if (t1 < 1) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

/** Douglas–Peucker */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = len === 1 && dx === 0 && dy === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring: Pt[], tol: number): Pt[] {
  if (ring.length <= 4) return ring;
  // split at the two points farthest apart so the closed ring simplifies as two open lines
  let far = 1;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplify(ring.slice(0, far + 1), tol);
  const b = simplify([...ring.slice(far), ring[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function fit(pts: Pt[], closed: boolean): Pt[] {
  let tol = closed ? 0.4 : 0.6;
  let out = closed ? simplifyRing(pts, tol) : simplify(pts, tol);
  while (out.length > MAX_POINTS) {
    tol *= 2;
    out = closed ? simplifyRing(pts, tol) : simplify(pts, tol);
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const flat = (pts: Pt[]): number[] => pts.flatMap(([x, y]) => [round1(x), round1(y)]);

// --- classification ----------------------------------------------------------------------------

/** metres, by highway class (the carriageway; pavements are the ground left between it and the houses) */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 10, trunk: 10, primary: 9, secondary: 8, tertiary: 7,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  residential: 6, unclassified: 6, living_street: 5.5, road: 6, busway: 6,
  service: 4, pedestrian: 5.5,
};
const PATH_WIDTH: Record<string, number> = { footway: 2.4, path: 2, steps: 2.4, cycleway: 2.6, track: 3, bridleway: 2, corridor: 2 };
const WATERWAY_WIDTH: Record<string, number> = { river: 12, canal: 8, stream: 3, ditch: 2, drain: 2 };

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

const clean = (s: string | undefined, max: number): string | undefined => {
  const v = s?.replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
};

const GROUNDS: ReadonlySet<string> = new Set(['school', 'university', 'college', 'kindergarten', 'hospital']);
const POI_KEYS = ['amenity', 'shop', 'tourism', 'historic', 'office', 'leisure', 'railway', 'highway'] as const;

function subtype(tags: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = tags[k];
    if (v && v !== 'yes') return clean(v, 40);
  }
  return undefined;
}

interface Draft {
  kind: PlaceFeature['kind'];
  name?: string;
  type?: string;
  osm: string;
  width?: number;
  levels?: number;
  closed: boolean;
  pts: Pt[];
}

type Shape = { kind: PlaceFeature['kind']; area: boolean; type?: string; width?: number } | null;

/** what a way or relation is, by its tags; null = not something the patch keeps */
function classify(tags: Record<string, string>, closed: boolean): Shape {
  if (tags.location === 'underground' || tags.tunnel === 'yes' || tags.tunnel === 'culvert') return null;
  if (tags.building && tags.building !== 'no') return closed ? { kind: 'building', area: true, type: subtype(tags, ['amenity', 'shop', 'tourism', 'historic', 'office', 'leisure', 'railway', 'building']) } : null;
  if (tags.place === 'square' && closed) return { kind: 'square', area: true, type: 'square' };
  const hw = tags.highway;
  if (hw) {
    if (closed && (tags.area === 'yes' || tags.place === 'square') && (hw === 'pedestrian' || hw === 'footway')) return { kind: 'square', area: true, type: hw === 'pedestrian' ? 'square' : 'paved' };
    if (tags.indoor === 'yes' || tags.level?.startsWith('-')) return null;
    const lanes = num(tags.lanes);
    const tagged = num(tags.width) ?? (lanes ? lanes * 3 : undefined);
    if (ROAD_WIDTH[hw] !== undefined) return { kind: 'road', area: false, type: hw, width: tagged ?? ROAD_WIDTH[hw] };
    if (PATH_WIDTH[hw] !== undefined) return { kind: 'path', area: false, type: hw, width: tagged ?? PATH_WIDTH[hw] };
    return null;
  }
  if (tags.natural === 'coastline') return { kind: 'water', area: false, type: 'coastline' };
  if (tags.natural === 'water' || tags.natural === 'bay' || tags.waterway === 'riverbank' || tags.waterway === 'dock') return closed ? { kind: 'water', area: true, type: clean(tags.water ?? tags.waterway ?? 'water', 40) } : null;
  if (tags.waterway && WATERWAY_WIDTH[tags.waterway] !== undefined) return { kind: 'water', area: false, type: tags.waterway, width: num(tags.width) ?? WATERWAY_WIDTH[tags.waterway] };
  if (tags.railway) return { kind: 'rail', area: false, type: tags.railway, width: tags.railway === 'tram' ? 2.5 : 3.5 };
  if (tags.barrier) return { kind: 'barrier', area: false, type: tags.barrier, width: 0.5 };
  const green = tags.leisure ?? tags.landuse ?? tags.natural;
  if (green && closed) return { kind: 'green', area: true, type: clean(green, 40) };
  return null;
}

/** joins a relation's outer member ways into closed rings */
function outerRings(el: OsmElement, project: (p: OsmLatLon) => Pt): Pt[][] {
  const parts: Pt[][] = [];
  for (const m of el.members ?? []) {
    if (m.type !== 'way' || (m.role && m.role !== 'outer') || !m.geometry) continue;
    const pts = m.geometry.filter((p): p is OsmLatLon => !!p).map(project);
    if (pts.length >= 2) parts.push(pts);
  }
  const rings: Pt[][] = [];
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
  while (parts.length) {
    let ring = parts.shift()!;
    for (let guard = 0; guard < 200 && !same(ring[0]!, ring[ring.length - 1]!); guard++) {
      const end = ring[ring.length - 1]!;
      const k = parts.findIndex((p) => same(p[0]!, end) || same(p[p.length - 1]!, end));
      if (k === -1) break;
      const next = parts.splice(k, 1)[0]!;
      ring = ring.concat((same(next[0]!, end) ? next : next.reverse()).slice(1));
    }
    if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) rings.push(ring.slice(0, -1));
  }
  return rings;
}

// --- the builder -------------------------------------------------------------------------------

/** importance order when the feature cap bites: the last kinds are dropped first */
const KIND_ORDER: PlaceFeature['kind'][] = ['building', 'road', 'square', 'water', 'green', 'path', 'rail', 'barrier', 'poi', 'tree'];

export function buildPatch(elements: readonly OsmElement[], opts: PatchOptions): PlacePatch {
  const extent = opts.extent ?? DEFAULT_EXTENT;
  const half = extent / 2 + 3; // a small margin so shapes are cut outside the map's edge, not on it
  const flatProject = projector(opts.lat, opts.lon);
  const rotation = Math.max(-45, Math.min(45, opts.rotation ?? dominantAngle(elements, flatProject, Math.min(extent * 0.75, 120))));
  const cos = Math.cos((rotation * Math.PI) / 180);
  const sin = Math.sin((rotation * Math.PI) / 180);
  const project = (p: OsmLatLon): Pt => {
    const [x, y] = flatProject(p);
    return [x * cos + y * sin, -x * sin + y * cos];
  };
  const drafts: Draft[] = [];
  const pois: Draft[] = [];
  const grounds: { name: string; type: string; ring: Pt[] }[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const osm = `${el.type[0]}${el.id}`;
    const name = clean(tags.name, 80);
    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      const p = project({ lat: el.lat, lon: el.lon });
      if (Math.abs(p[0]) > half || Math.abs(p[1]) > half) continue;
      if (tags.natural === 'tree') drafts.push({ kind: 'tree', osm, closed: false, pts: [p] });
      else {
        const type = subtype(tags, POI_KEYS);
        if (type) pois.push({ kind: 'poi', osm, closed: false, pts: [p], type, ...(name ? { name } : {}) });
      }
      continue;
    }
    let rings: Pt[][] = [];
    let lines: Pt[][] = [];
    let closed = false;
    if (el.type === 'way') {
      const pts = (el.geometry ?? []).filter((p): p is OsmLatLon => !!p).map(project);
      if (pts.length < 2) continue;
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      closed = pts.length >= 4 && Math.abs(first[0] - last[0]) < 0.05 && Math.abs(first[1] - last[1]) < 0.05;
      if (closed) rings = [pts.slice(0, -1)];
      lines = [pts];
    } else {
      rings = outerRings(el, project);
      closed = rings.length > 0;
    }
    // the grounds of a school or hospital: not drawn, but their unnamed buildings take the name
    if (!tags.building && name && closed && GROUNDS.has(tags.amenity ?? '')) for (const ring of rings) grounds.push({ name, type: tags.amenity!, ring });
    const shape = classify(tags, closed);
    if (!shape) continue;
    const base = { kind: shape.kind, osm, ...(name ? { name } : {}), ...(shape.type ? { type: shape.type } : {}) };
    if (shape.area) {
      for (const ring of rings) {
        const clipped = clipRing(ring, half);
        if (clipped.length < 3 || ringArea(clipped) < (shape.kind === 'building' ? 6 : 10)) continue;
        const levels = shape.kind === 'building' ? num(tags['building:levels']) : undefined;
        drafts.push({ ...base, closed: true, pts: fit(clipped, true), ...(levels !== undefined ? { levels: Math.min(200, Math.max(0, levels)) } : {}) });
      }
    } else {
      for (const piece of lines.flatMap((l) => clipLine(l, half))) {
        drafts.push({ ...base, closed: false, pts: fit(piece, false), ...(shape.width !== undefined ? { width: Math.min(60, Math.max(0.2, shape.width)) } : {}) });
      }
    }
  }

  // an unnamed building takes the name (and kind of business) of a named place inside it
  const buildings = drafts.filter((d) => d.kind === 'building');
  for (const poi of pois) {
    if (!poi.name) continue;
    const [x, y] = poi.pts[0]!;
    const host = buildings.find((b) => pointInRing(x, y, b.pts));
    if (host && !host.name) {
      host.name = poi.name;
      if (!host.type || host.type === 'retail' || host.type === 'commercial' || host.type === 'apartments' || host.type === 'residential') host.type = poi.type;
    }
  }

  for (const b of buildings) {
    if (b.name) continue;
    const [x, y] = centroid(b.pts);
    const g = grounds.find((gr) => pointInRing(x, y, gr.ring));
    // sheds and bike racks stay nameless
    if (g && ringArea(b.pts) >= 120) {
      b.name = g.name;
      if (!b.type || b.type === 'school' || b.type === 'university' || b.type === 'hospital' || b.type === 'public' || b.type === 'civic') b.type = g.type;
    }
  }

  const size = (d: Draft) => (d.closed ? ringArea(d.pts) : d.pts.length);
  const all = [...drafts, ...pois.filter((p) => p.name || p.type === 'fountain')];
  // stable order: by kind importance, named first, then bigger first, then by OSM id
  all.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      Number(!!b.name) - Number(!!a.name) ||
      size(b) - size(a) ||
      (a.osm < b.osm ? -1 : a.osm > b.osm ? 1 : 0),
  );
  const features: PlaceFeature[] = all.slice(0, MAX_FEATURES).map((d) => ({
    kind: d.kind,
    ...(d.name ? { name: d.name } : {}),
    ...(d.type ? { type: d.type } : {}),
    osm: d.osm,
    ...(d.width !== undefined ? { width: round1(d.width) } : {}),
    ...(d.levels !== undefined ? { levels: d.levels } : {}),
    geometry: flat(d.pts),
  }));
  return { id: opts.id, name: opts.name.slice(0, 60), kind: 'outdoor', centre: { lat: opts.lat, lon: opts.lon }, extent, rotation, scale: opts.scale ?? 'street', features };
}

// --- summaries ---------------------------------------------------------------------------------

export interface Landmark {
  name: string;
  type?: string;
  kind: PlaceFeature['kind'];
  /** metres from the patch centre */
  x: number;
  y: number;
  lat: number;
  lon: number;
  /** m² for areas, 0 for points */
  size: number;
}

export interface PatchSummary {
  buildings: number;
  namedBuildings: number;
  roads: string[];
  squares: string[];
  greens: number;
  trees: number;
  water: boolean;
  landmarks: Landmark[];
  /** too little mapped here for a recognisable area */
  sparse: boolean;
}

function ringOf(f: PlaceFeature): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < f.geometry.length; i += 2) out.push([f.geometry[i]!, f.geometry[i + 1]!]);
  return out;
}

/** landmark types that make a place recognisable come first */
const TYPE_RANK = ['cathedral', 'church', 'place_of_worship', 'school', 'university', 'college', 'townhall', 'station', 'train_station', 'museum', 'library', 'theatre', 'cinema', 'hospital', 'square', 'park', 'hotel', 'supermarket'];
const rank = (t: string | undefined) => {
  const k = t ? TYPE_RANK.indexOf(t) : -1;
  return k === -1 ? TYPE_RANK.length : k;
};

/** counts and the named things of a patch, for the picker and (later) the world prompt */
export function patchSummary(patch: PlacePatch): PatchSummary {
  const uniq = (names: (string | undefined)[]) => [...new Set(names.filter((n): n is string => !!n))];
  const of = (kind: PlaceFeature['kind']) => patch.features.filter((f) => f.kind === kind);
  const landmarks: Landmark[] = [];
  const seen = new Set<string>();
  for (const f of patch.features) {
    if (!f.name || seen.has(f.name) || !['building', 'square', 'green', 'poi', 'water'].includes(f.kind)) continue;
    seen.add(f.name);
    const ring = ringOf(f);
    const [x, y] = ring.length > 1 ? centroid(ring) : ring[0]!;
    landmarks.push({
      name: f.name,
      ...(f.type ? { type: f.type } : {}),
      kind: f.kind,
      x,
      y,
      ...unproject(patch.centre.lat, patch.centre.lon, x, y, patch.rotation),
      size: ring.length > 2 ? Math.round(ringArea(ring)) : 0,
    });
  }
  landmarks.sort((a, b) => rank(a.type) - rank(b.type) || b.size - a.size || a.name.localeCompare(b.name));
  const buildings = of('building');
  const roads = uniq([...of('road'), ...of('path')].map((f) => f.name));
  return {
    buildings: buildings.length,
    namedBuildings: buildings.filter((b) => b.name).length,
    roads,
    squares: uniq(of('square').map((f) => f.name)),
    greens: of('green').length,
    trees: of('tree').length,
    water: of('water').length > 0,
    landmarks,
    sparse: buildings.length + of('road').length + of('path').length < 6,
  };
}
