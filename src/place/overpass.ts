/**
 * Map data around a point from OpenStreetMap's Overpass API (docs/PLACE-PLAN.md §2). One query per
 * patch, `out geom` so coordinates come inline. Overpass is rate-limited and sometimes down: a
 * timeout, one retry on a mirror, and honest errors (PlaceError) are part of the design.
 * Browser-safe and Node-safe (global fetch only).
 */

export type PlaceErrorKind = 'network' | 'timeout' | 'busy' | 'empty';

export class PlaceError extends Error {
  readonly kind: PlaceErrorKind;
  constructor(kind: PlaceErrorKind, message: string) {
    super(message);
    this.name = 'PlaceError';
    this.kind = kind;
  }
}

export interface OsmLatLon {
  lat: number;
  lon: number;
}

/** an Overpass element as `out geom` returns it (only the fields used here) */
export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: (OsmLatLon | null)[];
  members?: { type: string; role?: string; geometry?: (OsmLatLon | null)[] }[];
}

export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export interface FetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** per request, ms (default 40 000: the public servers are often slow) */
  timeoutMs?: number;
  endpoints?: string[];
  /** Node only: browsers send a Referer instead and may not set this header */
  userAgent?: string;
}

/**
 * The Overpass QL for everything the patch builder understands within `radius` metres of the point.
 * A global bounding box (the square around the circle) with plain tag filters: much faster on the
 * public servers than an `around` filter per statement.
 */
export function overpassQuery(lat: number, lon: number, radius: number): string {
  const dLat = radius / 110_540;
  const dLon = radius / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(6)).join(',');
  const both = (filter: string) => `way${filter};relation${filter};`;
  return [
    `[out:json][timeout:30][bbox:${bbox}];`,
    '(',
    both('[building]'),
    'way[highway];',
    both('[natural~"^(water|wood|scrub|grassland|heath|bay|beach|sand)$"]'),
    'way[waterway];',
    'way[natural=coastline];',
    both('[leisure~"^(park|garden|pitch|playground|common|dog_park)$"]'),
    both('[landuse~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|flowerbed)$"]'),
    both('[place=square]'),
    both('[amenity~"^(school|university|college|kindergarten|hospital)$"][name]'),
    'way[barrier~"^(wall|city_wall|retaining_wall)$"];',
    'way[railway~"^(rail|tram|light_rail|subway|narrow_gauge)$"];',
    'node[natural=tree];',
    'node[amenity][name];node[shop][name];node[tourism][name];node[historic][name];node[office][name];node[leisure][name];',
    'node[amenity=fountain];node[highway=bus_stop][name];node[railway~"^(station|tram_stop|halt)$"];',
    ');',
    'out geom qt;',
  ].join('');
}

async function request(endpoint: string, query: string, opts: FetchOptions): Promise<OsmElement[]> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? 40_000);
  try {
    const res = await f(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}) },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctl.signal,
    });
    if (res.status === 429 || res.status === 504 || res.status === 503) throw new PlaceError('busy', `the map service is busy (${res.status})`);
    if (!res.ok) throw new PlaceError('network', `the map service answered ${res.status}`);
    const json = (await res.json()) as { elements?: OsmElement[]; remark?: string };
    if (!Array.isArray(json.elements)) throw new PlaceError('network', 'the map service sent no elements');
    // a query that ran out of time or memory answers 200 with a remark and partial data
    if (json.remark && /timed out|out of memory/i.test(json.remark) && json.elements.length === 0) throw new PlaceError('busy', json.remark);
    return json.elements;
  } catch (e) {
    if (e instanceof PlaceError) throw e;
    if (timedOut) throw new PlaceError('timeout', 'the map service took too long');
    if (opts.signal?.aborted) throw e;
    throw new PlaceError('network', `the map service could not be reached: ${String((e as Error)?.message ?? e)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Everything mapped within `radius` metres of the point. Tries each endpoint once, in order; throws
 * the last PlaceError when all fail, and PlaceError('empty') when the area holds nothing.
 */
export async function fetchOsm(lat: number, lon: number, radius: number, opts: FetchOptions = {}): Promise<OsmElement[]> {
  const query = overpassQuery(lat, lon, radius);
  let last: PlaceError | null = null;
  for (const endpoint of opts.endpoints ?? OVERPASS_ENDPOINTS) {
    try {
      const elements = await request(endpoint, query, opts);
      if (elements.length === 0) throw new PlaceError('empty', 'nothing is mapped here');
      return elements;
    } catch (e) {
      if (!(e instanceof PlaceError)) throw e;
      last = e;
      if (e.kind === 'empty') break;
    }
  }
  throw last ?? new PlaceError('network', 'the map service could not be reached');
}
