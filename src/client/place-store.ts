/**
 * What this browser remembers about real places (docs/PLACE-PLAN.md §5): the places picked lately,
 * and their map patches for a week, so picking the same square again costs no request to the map
 * service. Everything is optional: with storage blocked or full the picker just fetches again.
 */
import { PlacePatch } from '../schema/place';
import type { GeoHit } from '../place/geocode';

const RECENT_KEY = 'anyworld.place.recent.v1';
const CACHE_KEY = 'anyworld.place.cache.v1';
const MAX_RECENT = 6;
const MAX_CACHED = 5;
const WEEK = 7 * 24 * 3600 * 1000;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const sameSpot = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.abs(a.lat - b.lat) < 0.0002 && Math.abs(a.lon - b.lon) < 0.0004;

export function recentPlaces(): GeoHit[] {
  const list = read<unknown>(RECENT_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is GeoHit => !!p && typeof p === 'object' && typeof (p as GeoHit).name === 'string' && Number.isFinite((p as GeoHit).lat) && Number.isFinite((p as GeoHit).lon)).slice(0, MAX_RECENT);
}

export function rememberPlace(hit: GeoHit): void {
  const rest = recentPlaces().filter((p) => !sameSpot(p, hit));
  write(RECENT_KEY, [{ name: hit.name, displayName: hit.displayName, lat: hit.lat, lon: hit.lon, type: hit.type }, ...rest].slice(0, MAX_RECENT));
}

interface Cached {
  key: string;
  at: number;
  patch: unknown;
}

/** places within ~20 m of each other share a patch */
const cacheKey = (lat: number, lon: number, extent: number) => `${lat.toFixed(4)},${lon.toFixed(4)},${extent}`;

export function cachedPatch(lat: number, lon: number, extent: number, now = Date.now()): PlacePatch | null {
  const list = read<Cached[]>(CACHE_KEY, []);
  if (!Array.isArray(list)) return null;
  const hit = list.find((c) => c && c.key === cacheKey(lat, lon, extent) && now - c.at < WEEK);
  if (!hit) return null;
  const parsed = PlacePatch.safeParse(hit.patch);
  return parsed.success ? parsed.data : null;
}

export function cachePatch(lat: number, lon: number, extent: number, patch: PlacePatch, now = Date.now()): void {
  const key = cacheKey(lat, lon, extent);
  let list = read<Cached[]>(CACHE_KEY, []);
  if (!Array.isArray(list)) list = [];
  list = [{ key, at: now, patch }, ...list.filter((c) => c && c.key !== key && now - c.at < WEEK)].slice(0, MAX_CACHED);
  // no room: keep fewer rather than none
  while (list.length && !write(CACHE_KEY, list)) list.pop();
}
