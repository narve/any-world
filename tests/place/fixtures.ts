import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OsmElement } from '../../src/place/overpass';
import { buildPatch } from '../../src/place/patch';
import type { PlacePatch } from '../../src/schema/place';

/** recorded Overpass answers (tools/place-fetch.ts): a town square, a cathedral, schools, a village, a foreign block */
export const PLACE_FIXTURES = ['torvet', 'domkirken', 'kkg', 'kuben', 'tangen', 'lyngor', 'placa-reial'] as const;
export type PlaceFixtureId = (typeof PLACE_FIXTURES)[number];

export interface PlaceFixture {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  extent: number;
  elements: OsmElement[];
}

export function loadFixture(id: PlaceFixtureId): PlaceFixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/osm/${id}.json`, import.meta.url)), 'utf8')) as PlaceFixture;
}

export function fixturePatch(id: PlaceFixtureId): PlacePatch {
  const fx = loadFixture(id);
  return buildPatch(fx.elements, { id, name: fx.name, lat: fx.lat, lon: fx.lon, extent: fx.extent });
}
