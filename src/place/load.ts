/**
 * A place ready for a world: the map data around a point, built into a WorldPlace with one patch.
 * Shared by the browser picker and the tools.
 */
import type { PlacePatch, WorldPlace } from '../schema/place';
import type { GeoHit } from './geocode';
import { fetchOsm, PlaceError, type FetchOptions } from './overpass';
import { buildPatch, DEFAULT_EXTENT, patchRadius } from './patch';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** "Torvet, Kristiansand" → "torvet-kristiansand" (a patch id) */
export function placeId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'place';
}

export async function loadPatch(hit: Pick<GeoHit, 'name' | 'lat' | 'lon'>, opts: FetchOptions & { extent?: number } = {}): Promise<PlacePatch> {
  const extent = opts.extent ?? DEFAULT_EXTENT;
  const elements = await fetchOsm(hit.lat, hit.lon, patchRadius(extent), opts);
  const patch = buildPatch(elements, { id: placeId(hit.name), name: hit.name, lat: hit.lat, lon: hit.lon, extent });
  if (patch.features.length < 3) throw new PlaceError('empty', 'nothing is mapped here');
  return patch;
}

/** the WorldSpec.place for a hit and its patch; `now` is the fetch date (ISO) */
export function worldPlace(hit: Pick<GeoHit, 'name' | 'displayName' | 'lat' | 'lon'>, patch: PlacePatch, now: string): WorldPlace {
  return {
    name: hit.name.slice(0, 80),
    displayName: hit.displayName.slice(0, 240),
    lat: hit.lat,
    lon: hit.lon,
    source: 'osm',
    fetchedAt: now,
    attribution: OSM_ATTRIBUTION,
    patches: [patch],
  };
}
