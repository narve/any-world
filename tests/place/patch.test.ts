import { describe, expect, it } from 'vitest';
import type { OsmElement } from '../../src/place/overpass';
import { buildPatch, dominantAngle, patchRadius, patchSummary, projector, unproject } from '../../src/place/patch';
import { PlacePatch } from '../../src/schema/place';
import { PLACE_FIXTURES, fixturePatch, loadFixture } from './fixtures';

/** a w×d metre rectangle around (cx, cy) metres from (lat0, lon0), turned by `deg`, as an OSM way */
function rect(id: number, lat0: number, lon0: number, cx: number, cy: number, w: number, d: number, deg: number, tags: Record<string, string>): OsmElement {
  const a = (deg * Math.PI) / 180;
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]];
  const geometry = corners.map(([x, y]) => {
    const rx = cx + x! * Math.cos(a) - y! * Math.sin(a);
    const ry = cy + x! * Math.sin(a) + y! * Math.cos(a);
    return unproject(lat0, lon0, rx, ry);
  });
  return { type: 'way', id, tags, geometry };
}

describe('place patches from recorded map data', () => {
  for (const id of PLACE_FIXTURES) {
    it(`${id}: a valid, compact, deterministic patch`, () => {
      const patch = fixturePatch(id);
      expect(PlacePatch.safeParse(patch).success).toBe(true);
      expect(patch.features.length).toBeGreaterThan(10);
      expect(JSON.stringify(patch).length).toBeLessThan(60_000);
      expect(Math.abs(patch.rotation)).toBeLessThanOrEqual(45);
      // everything is clipped to the patch square (with its small margin)
      const reach = patch.extent / 2 + 3.05;
      for (const f of patch.features) for (const v of f.geometry) expect(Math.abs(v)).toBeLessThanOrEqual(reach);
      expect(JSON.stringify(fixturePatch(id))).toBe(JSON.stringify(patch));
    });
  }

  it('keeps the real names and kinds', () => {
    const s = patchSummary(fixturePatch('domkirken'));
    expect(s.landmarks[0]!.name).toBe('Kristiansand domkirke');
    expect(s.roads).toEqual(expect.arrayContaining(['Kirkegata', 'Rådhusgata', 'Gyldenløves gate']));
    expect(s.squares).toContain('Nedre torv');
    expect(s.trees).toBeGreaterThan(5);
    expect(s.sparse).toBe(false);
    const tangen = fixturePatch('tangen');
    expect(tangen.features.some((f) => f.kind === 'water' && f.name === 'Otra')).toBe(true);
  });

  it('gives a landmark its coordinates back', () => {
    const fx = loadFixture('domkirken');
    const patch = fixturePatch('domkirken');
    const church = patchSummary(patch).landmarks.find((l) => l.name === 'Kristiansand domkirke')!;
    // the cathedral is the fixture's own centre, within a few tens of metres
    expect(Math.abs(church.lat - fx.lat)).toBeLessThan(0.0004);
    expect(Math.abs(church.lon - fx.lon)).toBeLessThan(0.0008);
  });

  it('names the unnamed buildings of a school after the school', () => {
    const s = patchSummary(fixturePatch('kkg'));
    expect(s.namedBuildings).toBeGreaterThan(0);
    expect(s.landmarks.some((l) => l.name === 'Kristiansand katedralskole Gimle' && l.kind === 'building')).toBe(true);
  });
});

describe('patch builder', () => {
  const lat = 58.15;
  const lon = 8.0;

  it('turns the ground so the house walls follow the grid', () => {
    const els = [0, 1, 2, 3].map((k) => rect(k + 1, lat, lon, (k % 2) * 30 - 15, Math.floor(k / 2) * 30 - 15, 18, 10, 30, { building: 'yes' }));
    const angle = dominantAngle(els, projector(lat, lon), 200);
    expect(angle).toBeGreaterThan(28);
    expect(angle).toBeLessThan(32);
    const patch = buildPatch(els, { id: 'p', name: 'P', lat, lon });
    expect(patch.rotation).toBeCloseTo(angle, 5);
    // after turning, every wall runs along an axis
    for (const f of patch.features) {
      const g = f.geometry;
      for (let i = 0; i + 3 < g.length; i += 2) expect(Math.min(Math.abs(g[i]! - g[i + 2]!), Math.abs(g[i + 1]! - g[i + 3]!))).toBeLessThan(0.6);
    }
    // 60° is the same grid as −30°
    const sixty = [rect(1, lat, lon, 0, 0, 20, 10, 60, { building: 'yes' })];
    expect(dominantAngle(sixty, projector(lat, lon), 200)).toBeCloseTo(-30, 0);
  });

  it('clips shapes to the patch and drops what lies outside', () => {
    const els: OsmElement[] = [
      rect(1, lat, lon, 0, 0, 400, 20, 0, { building: 'yes', name: 'Long hall' }),
      rect(2, lat, lon, 500, 500, 20, 20, 0, { building: 'yes', name: 'Far away' }),
      { type: 'way', id: 3, tags: { highway: 'residential', name: 'Storgata' }, geometry: [unproject(lat, lon, -300, 40), unproject(lat, lon, 300, 40)] },
      { type: 'node', id: 4, tags: { natural: 'tree' }, ...unproject(lat, lon, 10, 60) },
      { type: 'node', id: 5, tags: { natural: 'tree' }, ...unproject(lat, lon, 10, 600) },
    ];
    const patch = buildPatch(els, { id: 'p', name: 'P', lat, lon, extent: 160, rotation: 0 });
    expect(patch.features.map((f) => f.name ?? f.kind)).toEqual(['Long hall', 'Storgata', 'tree']);
    const hall = patch.features[0]!;
    expect(Math.max(...hall.geometry.map(Math.abs))).toBeLessThanOrEqual(83.05);
    const road = patch.features[1]!;
    expect(road.kind).toBe('road');
    expect(road.width).toBe(6);
    expect(road.geometry).toEqual([-83, 40, 83, 40]);
  });

  it('classifies ways by their tags', () => {
    const line = (id: number, tags: Record<string, string>): OsmElement => ({ type: 'way', id, tags, geometry: [unproject(lat, lon, -20, id * 3), unproject(lat, lon, 20, id * 3)] });
    const els: OsmElement[] = [
      line(1, { highway: 'footway' }),
      line(2, { highway: 'primary', lanes: '4' }),
      line(3, { highway: 'residential', tunnel: 'yes' }),
      line(4, { railway: 'tram' }),
      line(5, { waterway: 'stream' }),
      line(6, { barrier: 'wall' }),
      line(7, { highway: 'proposed' }),
      rect(8, lat, lon, 40, 40, 30, 30, 0, { leisure: 'park', name: 'Parken' }),
      rect(9, lat, lon, -40, 40, 30, 30, 0, { highway: 'pedestrian', area: 'yes', name: 'Torget' }),
      rect(10, lat, lon, -40, -40, 30, 30, 0, { natural: 'water' }),
      rect(11, lat, lon, 40, -40, 30, 30, 0, { building: 'yes' }),
      { type: 'node', id: 12, tags: { shop: 'bakery', name: 'Bakeriet' }, ...unproject(lat, lon, 40, -40) },
    ];
    const patch = buildPatch(els, { id: 'p', name: 'P', lat, lon, rotation: 0 });
    const by = (osm: string) => patch.features.find((f) => f.osm === osm);
    expect(by('w1')).toMatchObject({ kind: 'path', type: 'footway' });
    expect(by('w2')).toMatchObject({ kind: 'road', type: 'primary', width: 12 });
    expect(by('w3')).toBeUndefined();
    expect(by('w4')).toMatchObject({ kind: 'rail' });
    expect(by('w5')).toMatchObject({ kind: 'water', width: 3 });
    expect(by('w6')).toMatchObject({ kind: 'barrier' });
    expect(by('w7')).toBeUndefined();
    expect(by('w8')).toMatchObject({ kind: 'green', name: 'Parken', type: 'park' });
    expect(by('w9')).toMatchObject({ kind: 'square', name: 'Torget' });
    expect(by('w10')).toMatchObject({ kind: 'water' });
    // an unnamed building takes the name and trade of the shop inside it
    expect(by('w11')).toMatchObject({ kind: 'building', name: 'Bakeriet', type: 'bakery' });
    expect(by('n12')).toMatchObject({ kind: 'poi', name: 'Bakeriet' });
  });

  it('joins the outer ways of a multipolygon relation', () => {
    const a = unproject(lat, lon, -10, -10);
    const b = unproject(lat, lon, 10, -10);
    const c = unproject(lat, lon, 10, 10);
    const d = unproject(lat, lon, -10, 10);
    const rel: OsmElement = {
      type: 'relation',
      id: 9,
      tags: { type: 'multipolygon', building: 'school', name: 'Skolen' },
      members: [
        { type: 'way', role: 'outer', geometry: [a, b, c] },
        { type: 'way', role: 'outer', geometry: [a, d, c] },
        { type: 'way', role: 'inner', geometry: [a, b, a] },
      ],
    };
    const patch = buildPatch([rel], { id: 'p', name: 'P', lat, lon, rotation: 0 });
    expect(patch.features).toHaveLength(1);
    expect(patch.features[0]).toMatchObject({ kind: 'building', name: 'Skolen', osm: 'r9' });
    expect(patch.features[0]!.geometry).toHaveLength(8);
  });

  it('the fetch radius covers the corners of the patch', () => {
    expect(patchRadius(160)).toBeGreaterThan(Math.hypot(80, 80));
    expect(patchRadius(160)).toBeLessThan(140);
  });
});
