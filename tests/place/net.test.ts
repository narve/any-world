import { describe, expect, it, vi } from 'vitest';
import { reversePlace, searchPlace } from '../../src/place/geocode';
import { loadPatch, placeId, worldPlace } from '../../src/place/load';
import { PlaceError, fetchOsm, overpassQuery } from '../../src/place/overpass';
import { WorldPlace } from '../../src/schema/place';
import { loadFixture } from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Overpass fetch', () => {
  it('asks for buildings, streets, water, green, trees and named places around the point', () => {
    const q = overpassQuery(58.1461, 7.9946, 125);
    const m = /\[bbox:([\d.,-]+)\]/.exec(q)!;
    const [s, w, n, e] = m[1]!.split(',').map(Number) as [number, number, number, number];
    expect((n - s) * 110_540).toBeCloseTo(250, 0);
    expect((e - w) * 111_320 * Math.cos((58.1461 * Math.PI) / 180)).toBeCloseTo(250, 0);
    expect((s + n) / 2).toBeCloseTo(58.1461, 5);
    for (const part of ['[building]', '[highway]', 'natural=coastline', 'natural=tree', '[shop][name]', 'out geom']) expect(q).toContain(part);
  });

  it('returns the elements of the first endpoint that answers', async () => {
    const fetchMock = vi.fn(async () => json({ elements: [{ type: 'node', id: 1, lat: 1, lon: 2 }] }));
    const els = await fetchOsm(58, 8, 100, { fetch: fetchMock as unknown as typeof fetch, endpoints: ['https://a.example/api', 'https://b.example/api'] });
    expect(els).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://a.example/api');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toMatch(/^data=/);
  });

  it('tries the mirror when the first endpoint is busy, and says busy when both are', async () => {
    const calls: string[] = [];
    const flaky = (async (url: string) => {
      calls.push(url);
      return url.includes('a.example') ? json({}, 429) : json({ elements: [{ type: 'node', id: 1 }] });
    }) as unknown as typeof fetch;
    expect(await fetchOsm(58, 8, 100, { fetch: flaky, endpoints: ['https://a.example', 'https://b.example'] })).toHaveLength(1);
    expect(calls).toEqual(['https://a.example', 'https://b.example']);
    const busy = (async () => json({}, 504)) as unknown as typeof fetch;
    await expect(fetchOsm(58, 8, 100, { fetch: busy, endpoints: ['https://a.example', 'https://b.example'] })).rejects.toMatchObject({ name: 'PlaceError', kind: 'busy' });
  });

  it('reports an empty area, a dead network and a timeout honestly', async () => {
    const empty = (async () => json({ elements: [] })) as unknown as typeof fetch;
    await expect(fetchOsm(0, 0, 100, { fetch: empty, endpoints: ['https://a.example', 'https://b.example'] })).rejects.toMatchObject({ kind: 'empty' });
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchOsm(0, 0, 100, { fetch: dead, endpoints: ['https://a.example'] })).rejects.toMatchObject({ kind: 'network' });
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    await expect(fetchOsm(0, 0, 100, { fetch: slow, endpoints: ['https://a.example'], timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(new PlaceError('busy', 'x')).toBeInstanceOf(Error);
  });
});

describe('geocoding', () => {
  it('maps Nominatim rows to hits', async () => {
    const fetchMock = vi.fn(async () => json([{ lat: '58.1461', lon: '7.9946', name: 'Kristiansand domkirke', display_name: 'Kristiansand domkirke, Kvadraturen, Kristiansand, Norge', type: 'place_of_worship' }, { lat: 'x' }]));
    const hits = await searchPlace(' Kristiansand domkirke ', { fetch: fetchMock as unknown as typeof fetch, language: 'nb' });
    expect(hits).toEqual([{ name: 'Kristiansand domkirke', displayName: 'Kristiansand domkirke, Kvadraturen, Kristiansand, Norge', lat: 58.1461, lon: 7.9946, type: 'place_of_worship' }]);
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain('q=Kristiansand%20domkirke');
    expect(url).toContain('accept-language=nb');
    expect(await searchPlace('   ', { fetch: fetchMock as unknown as typeof fetch })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reverse keeps the asked coordinate and survives an unmapped spot', async () => {
    const ok = (async () => json({ lat: '58.1', lon: '8.1', name: 'Markens gate', display_name: 'Markens gate, Kristiansand' })) as unknown as typeof fetch;
    expect(await reversePlace(58.14, 8.0, { fetch: ok })).toMatchObject({ name: 'Markens gate', lat: 58.14, lon: 8.0 });
    const none = (async () => json({ error: 'Unable to geocode' })) as unknown as typeof fetch;
    expect(await reversePlace(58.14, 8.0, { fetch: none })).toMatchObject({ name: '58.1400, 8.0000', lat: 58.14, lon: 8.0 });
    const busy = (async () => json({}, 429)) as unknown as typeof fetch;
    await expect(searchPlace('x', { fetch: busy })).rejects.toMatchObject({ kind: 'busy' });
  });
});

describe('a place for a world', () => {
  it('builds a valid WorldSpec.place from a hit', async () => {
    const fx = loadFixture('domkirken');
    const f = (async () => json({ elements: fx.elements })) as unknown as typeof fetch;
    const patch = await loadPatch(fx, { fetch: f });
    expect(patch.id).toBe('kristiansand-domkirke');
    const place = worldPlace(fx, patch, '2026-11-10T12:00:00.000Z');
    expect(WorldPlace.safeParse(place).success).toBe(true);
    expect(place.attribution).toContain('OpenStreetMap');
    expect(place.patches).toHaveLength(1);
  });

  it('refuses a spot with nothing on the map', async () => {
    const f = (async () => json({ elements: [{ type: 'node', id: 1, lat: 0, lon: 0, tags: { natural: 'tree' } }] })) as unknown as typeof fetch;
    await expect(loadPatch({ name: 'Nowhere', lat: 0, lon: 0 }, { fetch: f })).rejects.toMatchObject({ kind: 'empty' });
  });

  it('makes ids from names', () => {
    expect(placeId('Torvet, Kristiansand')).toBe('torvet-kristiansand');
    expect(placeId('Plaça Reial')).toBe('placa-reial');
    expect(placeId('Lyngør brygge æ')).toBe('lyngor-brygge-ae');
    expect(placeId('???')).toBe('place');
  });
});
