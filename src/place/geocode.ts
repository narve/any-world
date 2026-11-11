/**
 * Place name → coordinates (and back) with OpenStreetMap's Nominatim (docs/PLACE-PLAN.md §2).
 * Its usage policy: at most one request a second and no search-as-you-type, so the picker searches
 * on Enter or the button only. Browsers identify themselves with the Referer; Node passes a
 * User-Agent.
 */
import { PlaceError } from './overpass';

export interface GeoHit {
  /** short name: "Torvet" */
  name: string;
  /** full name: "Torvet, Kvadraturen, Kristiansand, Agder, Norge" */
  displayName: string;
  lat: number;
  lon: number;
  /** OSM class/type, e.g. "square", "school", "residential" */
  type: string;
}

export const NOMINATIM = 'https://nominatim.openstreetmap.org';

export interface GeocodeOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  language?: string;
  userAgent?: string;
  timeoutMs?: number;
}

interface NominatimRow {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  type?: string;
  category?: string;
  error?: unknown;
}

async function get(url: string, opts: GeocodeOptions): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? 12_000);
  try {
    const res = await f(url, { headers: { Accept: 'application/json', ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}) }, signal: ctl.signal });
    if (res.status === 429 || res.status === 503) throw new PlaceError('busy', `the place search is busy (${res.status})`);
    if (!res.ok) throw new PlaceError('network', `the place search answered ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof PlaceError) throw e;
    if (timedOut) throw new PlaceError('timeout', 'the place search took too long');
    if (opts.signal?.aborted) throw e;
    throw new PlaceError('network', `the place search could not be reached: ${String((e as Error)?.message ?? e)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function toHit(r: NominatimRow): GeoHit | null {
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const displayName = String(r.display_name ?? '').slice(0, 240);
  const name = (String(r.name ?? '').trim() || displayName.split(',')[0]!.trim() || 'Place').slice(0, 80);
  return { name, displayName, lat, lon, type: String(r.type ?? r.category ?? '') };
}

/** up to five places matching `query`, best first; an empty list when nothing matches */
export async function searchPlace(query: string, opts: GeocodeOptions = {}): Promise<GeoHit[]> {
  const q = query.trim();
  if (!q) return [];
  const lang = opts.language ? `&accept-language=${encodeURIComponent(opts.language)}` : '';
  const rows = await get(`${NOMINATIM}/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}${lang}`, opts);
  if (!Array.isArray(rows)) return [];
  return (rows as NominatimRow[]).map(toHit).filter((h): h is GeoHit => !!h);
}

/** the place at a coordinate (for "use my location"); a plain coordinate name when nothing is mapped there */
export async function reversePlace(lat: number, lon: number, opts: GeocodeOptions = {}): Promise<GeoHit> {
  const lang = opts.language ? `&accept-language=${encodeURIComponent(opts.language)}` : '';
  const fallback: GeoHit = { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, displayName: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, type: '' };
  const row = (await get(`${NOMINATIM}/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lon}${lang}`, opts)) as NominatimRow | null;
  if (!row || row.error) return fallback;
  const hit = toHit(row);
  // keep the asked coordinate: the patch should be centred on the player, not on the street's centroid
  return hit ? { ...hit, lat, lon } : fallback;
}
