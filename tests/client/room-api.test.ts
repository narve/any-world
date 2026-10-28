/**
 * MP3 D1: the rooms' HTTP client (src/client/room/api.ts): ok bodies checked with the protocol's
 * schemas, unavailable (network error, timeout, 5xx, a body that does not parse, a server without
 * rooms), outdated (health engine, 409), refused with the server's code; and against a real server.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { RoomsApi, engineDiffers, type ApiFetch } from '../../src/client/room/api';
import { boot, ENGINE, type Booted } from '../server/rooms-helpers';

const info = { code: 'K7QX', world: { id: 'w-1', title: 'West', genre: 'western', language: 'en' }, players: 1, maxPlayers: 8, phase: 'lobby', joinable: true };

function fake(answer: (url: string, init?: { method?: string; body?: string }) => { status: number; body?: unknown } | 'throw' | 'hang'): { f: ApiFetch; calls: { url: string; method: string; body?: unknown }[] } {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const f: ApiFetch = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const a = answer(url, init);
    if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (a === 'hang') return new Promise(() => {});
    return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: () => (a.body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(a.body)) });
  };
  return { f, calls };
}

const err = (kind: string, message = 'm', extra: Record<string, unknown> = {}) => ({ error: { kind, type: kind, message, ...extra } });

describe('RoomsApi with a fake fetch', () => {
  it('ok results are checked with the schemas; the URL carries the base', async () => {
    const { f, calls } = fake((url) => (url.endsWith('/api/rooms') ? { status: 200, body: { rooms: [info], max: 10 } } : { status: 200, body: info }));
    const api = new RoomsApi({ base: 'https://srv.example/', fetch: f, engine: 'v1' });
    expect(await api.listRooms()).toEqual({ ok: true, value: { rooms: [info], max: 10 } });
    expect(await api.getRoom('K7QX')).toEqual({ ok: true, value: info });
    expect(calls.map((c) => c.url)).toEqual(['https://srv.example/api/rooms', 'https://srv.example/api/rooms/K7QX']);
  });

  it('create posts the engine, the world and the options; the answers map to results', async () => {
    let status = 201;
    let body: unknown = { code: 'K7QX', token: 'AbCdEfGhIjKlMnOpQrStUv' };
    const { f, calls } = fake(() => ({ status, body }));
    const api = new RoomsApi({ base: '', fetch: f, engine: 'v1' });
    expect(await api.createRoom({ demo: 'fixture-western', options: { difficulty: 'hard' } })).toEqual({ ok: true, value: body });
    expect(calls[0]).toEqual({ url: '/api/rooms', method: 'POST', body: { engine: 'v1', demo: 'fixture-western', options: { difficulty: 'hard' } } });
    [status, body] = [409, err('outdated', 'old', { reload: true })];
    expect(await api.createRoom({ demo: 'x' })).toEqual({ ok: false, kind: 'outdated' });
    [status, body] = [503, err('server_full')];
    expect(await api.createRoom({ demo: 'x' })).toMatchObject({ ok: false, kind: 'refused', code: 'server_full', status: 503 });
    [status, body] = [400, err('invalid_world', 'Invalid world: meta: missing')];
    expect(await api.createRoom({ world: {} })).toMatchObject({ ok: false, kind: 'refused', code: 'invalid_world', message: 'Invalid world: meta: missing' });
    [status, body] = [429, err('rate_limit')];
    expect(await api.createRoom({ demo: 'x' })).toMatchObject({ kind: 'refused', code: 'rate_limit' });
    [status, body] = [201, { code: 'nope' }];
    expect(await api.createRoom({ demo: 'x' })).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('a network error, a timeout, a 5xx, no rooms route: unavailable; a missing room: refused no_room', async () => {
    let mode: 'throw' | 'hang' | '500' | '404route' | '404room' = 'throw';
    const { f } = fake(() => (mode === 'throw' || mode === 'hang' ? mode : mode === '500' ? { status: 502, body: undefined } : mode === '404route' ? { status: 404, body: err('bad_request', 'Unknown API route') } : { status: 404, body: err('no_room') }));
    const api = new RoomsApi({ base: '', fetch: f, timeoutMs: 30 });
    expect(await api.listRooms()).toMatchObject({ ok: false, kind: 'unavailable' });
    mode = 'hang';
    const t0 = Date.now();
    expect(await api.listRooms()).toEqual({ ok: false, kind: 'unavailable', detail: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
    mode = '500';
    expect(await api.health()).toMatchObject({ ok: false, kind: 'unavailable' });
    mode = '404route';
    expect(await api.listRooms()).toMatchObject({ ok: false, kind: 'unavailable' });
    mode = '404room';
    expect(await api.getRoom('ZZZZ')).toMatchObject({ ok: false, kind: 'refused', code: 'no_room', status: 404 });
  });

  it('health: another engine is outdated, dev matches anything', async () => {
    let engine = 'v2';
    const { f } = fake(() => ({ status: 200, body: { ok: true, uptimeS: 3, configured: [], engine } }));
    expect(await new RoomsApi({ base: '', fetch: f, engine: 'v1' }).health()).toEqual({ ok: false, kind: 'outdated' });
    engine = 'v1';
    expect(await new RoomsApi({ base: '', fetch: f, engine: 'v1' }).health()).toEqual({ ok: true, value: { engine: 'v1' } });
    engine = 'dev';
    expect((await new RoomsApi({ base: '', fetch: f, engine: 'v1' }).health()).ok).toBe(true);
    expect(engineDiffers('dev', 'v1')).toBe(false);
    expect(engineDiffers('v1', 'dev')).toBe(false);
    expect(engineDiffers(undefined, 'v1')).toBe(false);
    expect(engineDiffers('v2', 'v1')).toBe(true);
  });

  it('no fetch at all: unavailable, never a throw', async () => {
    const api = new RoomsApi({ base: '', fetch: () => { throw new Error('boom'); } });
    expect(await api.listRooms()).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});

describe('RoomsApi against a real server', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot();
  });
  afterAll(async () => {
    await b.stop();
  });

  it('health, create, list, get, upload, and refusals', async () => {
    const api = new RoomsApi({ base: b.base, engine: ENGINE });
    expect(await api.health()).toEqual({ ok: true, value: { engine: ENGINE } });
    expect(await new RoomsApi({ base: b.base, engine: 'v-other' }).health()).toEqual({ ok: false, kind: 'outdated' });
    expect(await new RoomsApi({ base: b.base, engine: 'v-other' }).createRoom({ demo: 'fixture-western' })).toEqual({ ok: false, kind: 'outdated' });
    const c = await api.createRoom({ demo: 'fixture-western', options: { maxPlayers: 4 } });
    if (!c.ok) throw new Error(JSON.stringify(c));
    const list = await api.listRooms();
    expect(list.ok && list.value.rooms.map((r) => r.code)).toEqual([c.value.code]);
    expect(await api.getRoom(c.value.code)).toMatchObject({ ok: true, value: { code: c.value.code, maxPlayers: 4, phase: 'lobby' } });
    expect(await api.getRoom('ZZZZ')).toMatchObject({ ok: false, kind: 'refused', code: 'no_room' });
    expect(await api.createRoom({ world: { nope: true } })).toMatchObject({ ok: false, kind: 'refused', code: 'invalid_world' });
    expect(await api.uploadWorld(c.value.code, 'AbCdEfGhIjKlMnOpQrStUv', { nope: true })).toMatchObject({ ok: false, kind: 'refused', code: 'invalid_world' });
  });

  it('a stopped server is unavailable', async () => {
    const api = new RoomsApi({ base: 'http://127.0.0.1:9', timeoutMs: 1000 });
    expect(await api.listRooms()).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});
