/**
 * A real place a world is anchored to (docs/PLACE-PLAN.md): map data from OpenStreetMap, kept in the
 * World Spec as simplified vector features in local metres. The `place` map generator rasterises a
 * patch at run start (src/engine/mapgen/generators/place.ts), so the same patch serves every map
 * size and party size, and the spec stays self-contained JSON.
 */
import { z } from 'zod';

const PlaceId = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const PLACE_FEATURE_KINDS = ['building', 'road', 'path', 'square', 'green', 'water', 'rail', 'barrier', 'tree', 'poi'] as const;

export const PlaceFeature = z.object({
  kind: z.enum(PLACE_FEATURE_KINDS),
  /** the real name: "Markens gate", "Kristiansand domkirke", "Narvesen" */
  name: z.string().max(80).optional(),
  /** OpenStreetMap subtype, trimmed: "school", "church", "bakery", "primary", "footway", "park" */
  type: z.string().max(40).optional(),
  /** OpenStreetMap element, e.g. "w123456" (attribution and tracing) */
  osm: z.string().max(24).optional(),
  /** roads, paths, rails and barriers: width in metres */
  width: z.number().min(0.2).max(60).optional(),
  /** buildings: storeys */
  levels: z.number().min(0).max(200).optional(),
  /**
   * Flat [x0, y0, x1, y1, …] in metres from the patch centre (x east, y south). A closed ring for
   * building / square / green / water areas, a line for road / path / rail / barrier (and for
   * water given as a line: a stream), one point for tree / poi.
   */
  geometry: z.array(z.number().min(-2000).max(2000)).min(2).max(400),
});
export type PlaceFeature = z.infer<typeof PlaceFeature>;

export const PlacePatch = z.object({
  id: PlaceId,
  name: z.string().max(60),
  kind: z.enum(['outdoor', 'interior']).default('outdoor'),
  /** where the patch is on Earth (attribution, preview, debugging; the engine does not use it) */
  centre: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  /** metres across the map's width; the height follows the map's shape */
  extent: z.number().min(40).max(400),
  /**
   * Degrees the ground was turned (|rotation| ≤ 45) so the streets and house walls run along the
   * tile grid; the features are stored already turned. 0 = north is up.
   */
  rotation: z.number().min(-45).max(45).default(0),
  /**
   * How the patch is drawn. 'street' (default): ~3 m per tile, a building is a house with rooms.
   * 'district': a whole neighbourhood (300–400 m across) on the same grid, drawn like a tourist
   * map: every building is one room, named buildings are always big enough to enter, and their
   * names are shown over the map.
   */
  scale: z.enum(['street', 'district']).default('street'),
  /**
   * The building the story is about (a building's name in `features`). The player then arrives by
   * a street at the edge of the map and the way on is inside this building, instead of starting in
   * the middle and leaving by a street.
   */
  focus: z.string().max(80).optional(),
  features: z.array(PlaceFeature).max(600),
});
export type PlacePatch = z.infer<typeof PlacePatch>;

export const WorldPlace = z.object({
  /** short name, "Torvet" */
  name: z.string().max(80),
  /** the geocoder's full name, "Torvet, Kvadraturen, Kristiansand, Agder, Norge" */
  displayName: z.string().max(240).default(''),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: z.literal('osm').default('osm'),
  /** ISO date of the fetch */
  fetchedAt: z.string().max(40).default(''),
  attribution: z.string().max(120).default('© OpenStreetMap contributors'),
  patches: z.array(PlacePatch).min(1).max(6),
});
export type WorldPlace = z.infer<typeof WorldPlace>;

/** cosmetic ground kinds the `place` generator marks on floor tiles (Tile.surface) */
export const TILE_SURFACES = ['road', 'path', 'pavement', 'grass', 'rail', 'plaza'] as const;
export type TileSurface = (typeof TILE_SURFACES)[number];
