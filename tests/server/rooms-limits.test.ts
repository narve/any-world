/**
 * MP2 C4: the room server's network edge (server/rooms/ws.ts, the /api/rooms routes in app.ts,
 * data-dir.ts): the Origin rule with and without ALLOWED_ORIGINS, other upgrade paths, frame size,
 * backpressure, the hello order and timeout, invalid and rate-dropped messages, per-IP limits (also
 * behind TRUST_PROXY), pings, close(), and the HTTP routes with their limits (409 outdated, server
 * full, creations per IP with invalid uploads counted, the first-area timing cap, world uploads with
 * the token in the body).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../../server/index';
import { ensureDataDir, resolveDataDir } from '../../server/data-dir';
import { wsConn, originAllowed, type WsLike } from '../../server/rooms/ws';
import { ConnBuckets } from '../../server/rooms/limits';
import { REPO_ROOT } from '../../server/engine-version';
import { LIMITS, type ServerMsg } from '../../src/net/protocol';
import { boot, createDemoRoom, ENGINE, getJson, hello, openRaw, postJson, sleep, until, upgradeStatus, type Booted } from './rooms-helpers';

let b: Booted | undefined;
afterEach(async () => {
  await b?.stop();
  b = undefined;
});

const western = () => JSON.parse(readFileSync(resolve(REPO_ROOT, 'content/worlds/fixture-western.json'), 'utf8')) as Record<string, unknown>;

describe('rooms: data directory', () => {
  it('takes ANYWORLD_DATA_DIR, then STATE_DIRECTORY, then .data/ in the repo', () => {
    expect(resolveDataDir({ ANYWORLD_DATA_DIR: '/srv/aw', STATE_DIRECTORY: '/var/lib/anyworld' }, '/repo')).toBe('/srv/aw');
    expect(resolveDataDir({ STATE_DIRECTORY: '/var/lib/anyworld' }, '/repo')).toBe('/var/lib/anyworld');
    expect(resolveDataDir({ NODE_ENV: 'production' }, '/repo')).toBe('/repo/.data');
  });

  it('creates <dir>/rooms and fails when it cannot write there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anyworld-dd-'));
    try {
      expect(ensureDataDir(join(dir, 'a', 'b'))).toBe(join(dir, 'a', 'b', 'rooms'));
      writeFileSync(join(dir, 'file'), 'x');
      expect(() => ensureDataDir(join(dir, 'file'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a server without rooms has no room routes and no upgrades', async () => {
    const s = await startServer({ port: 0, host: '127.0.0.1', env: {}, recordings: [], log: () => {} });
    try {
      expect((await getJson(`http://127.0.0.1:${s.port}/api/rooms`)).status).toBe(404);
      expect(s.rooms).toBeNull();
      expect(await upgradeStatus(`ws://127.0.0.1:${s.port}/api/ws`, { origin: `http://127.0.0.1:${s.port}` })).not.toBe(101);
    } finally {
      await s.close();
    }
  });
});

describe('rooms: upgrades', () => {
  it('Origin: listed origins only when ALLOWED_ORIGINS is set (production layout)', async () => {
    b = await boot({ allowedOrigins: ['https://any.dv8.no'] });
    expect(await upgradeStatus(b.wsUrl, { origin: 'https://any.dv8.no' })).toBe(101);
    expect(await upgradeStatus(b.wsUrl, { origin: b.origin })).toBe(403);
    expect(await upgradeStatus(b.wsUrl, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(b.wsUrl, {})).toBe(403);
  });

  it('Origin: the own host only when the list is empty (dev, or pages served by this server)', async () => {
    b = await boot();
    expect(await upgradeStatus(b.wsUrl, { origin: b.origin })).toBe(101);
    expect(await upgradeStatus(b.wsUrl, { origin: `https://127.0.0.1:${b.s.port}` })).toBe(101);
    expect(await upgradeStatus(b.wsUrl, { origin: 'http://127.0.0.1:1' })).toBe(403);
    expect(await upgradeStatus(b.wsUrl, {})).toBe(403);
    expect(originAllowed('http://a.b', 'a.b', new Set())).toBe(true);
    expect(originAllowed('http://a.b', 'a.b', new Set(['https://c.d']))).toBe(false);
    expect(originAllowed(undefined, 'a.b', new Set())).toBe(false);
  });

  it('other paths get 400', async () => {
    b = await boot();
    expect(await upgradeStatus(`ws://127.0.0.1:${b.s.port}/api/wsx`, { origin: b.origin })).toBe(400);
    expect(await upgradeStatus(`ws://127.0.0.1:${b.s.port}/`, { origin: b.origin })).toBe(400);
    // the server goes on
    expect((await getJson(`${b.base}/api/health`)).status).toBe(200);
  });

  it('per IP: upgrades per minute and open sockets; open sockets in all', async () => {
    b = await boot({ limits: { upgradesPerMin: 3, socketsPerIp: 2 } });
    const h = { origin: b.origin };
    const a = await openRaw(b.wsUrl, h);
    const c = await openRaw(b.wsUrl, h);
    expect(await upgradeStatus(b.wsUrl, h)).toBe(429); // a third open socket
    a.ws.close();
    await a.closed;
    expect(await upgradeStatus(b.wsUrl, h)).toBe(429); // the fourth upgrade this minute
    c.ws.close();
    await b.stop();
    b = await boot({ limits: { socketsTotal: 1 }, trustProxy: 1 });
    const d = await openRaw(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.1' });
    expect(await upgradeStatus(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.2' })).toBe(503);
    d.ws.close();
  });

  it('TRUST_PROXY: the per-IP limits see the forwarded address on upgrades', async () => {
    b = await boot({ limits: { socketsPerIp: 1 }, trustProxy: 1 });
    const x = await openRaw(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.1' });
    const y = await openRaw(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.2' });
    expect(await upgradeStatus(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.1' })).toBe(429);
    x.ws.close();
    y.ws.close();
    await b.stop();
    // without it, the header is ignored: every socket is the peer's
    b = await boot({ limits: { socketsPerIp: 1 } });
    const z = await openRaw(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.1' });
    expect(await upgradeStatus(b.wsUrl, { origin: b.origin, 'x-forwarded-for': '10.0.0.2' })).toBe(429);
    z.ws.close();
  });

  it('frames over 16 KB close the socket (1009)', async () => {
    b = await boot();
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    r.send('x'.repeat(LIMITS.frameBytes + 100));
    expect(await r.closed).toBe(1009);
  });

  it('pings: a client that never answers is terminated; one that answers stays', async () => {
    b = await boot({ limits: { pingMs: 40 } });
    const dead = await openRaw(b.wsUrl, { origin: b.origin }, { autoPong: false });
    const alive = await openRaw(b.wsUrl, { origin: b.origin });
    expect(await dead.closed).toBe(1006);
    expect(alive.ws.readyState).toBe(alive.ws.OPEN);
    alive.ws.close();
  });

  it('close() terminates the sockets (closeAllConnections does not reach them)', async () => {
    b = await boot();
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    const t0 = Date.now();
    await b.s.close(0);
    expect(await r.closed).toBe(1006);
    expect(Date.now() - t0).toBeLessThan(1000);
    rmSync(b.dataDir, { recursive: true, force: true });
    b = undefined;
  });
});

describe('rooms: hello and messages', () => {
  it('the engine is checked first: an outdated page is refused with reload, even with an invalid hello', async () => {
    b = await boot();
    const r1 = await openRaw(b.wsUrl, { origin: b.origin });
    r1.send(hello('ZZZZ', { engine: 'old' }));
    const m1 = await r1.next('refused');
    expect(m1).toMatchObject({ code: 'outdated', reload: true });
    expect(await r1.closed).toBe(4001);
    const r2 = await openRaw(b.wsUrl, { origin: b.origin });
    r2.send({ t: 'hello', engine: 'old', v: 99, room: 'not a code' });
    expect((await r2.next('refused')).code).toBe('outdated');
    expect(await r2.closed).toBe(4001);
  });

  it('then parsing, the room and the token', async () => {
    b = await boot();
    const r1 = await openRaw(b.wsUrl, { origin: b.origin });
    r1.send({ t: 'chat', text: 'hi' });
    expect((await r1.next('error')).code).toBe('invalid');
    r1.send({ t: 'hello', engine: ENGINE, v: 1 });
    await until(() => r1.of('error').length === 2);
    r1.send(hello('ZZZZ'));
    expect((await r1.next('refused')).code).toBe('no_room');
    expect(await r1.closed).toBe(4002);
    const { code } = await createDemoRoom(b);
    const r2 = await openRaw(b.wsUrl, { origin: b.origin });
    r2.send(hello(code, { token: 'A'.repeat(22) }));
    expect((await r2.next('refused')).code).toBe('bad_token');
    expect(await r2.closed).toBe(4005);
  });

  it('no hello in time closes with 4000', async () => {
    b = await boot({ timing: { helloTimeoutMs: 100 } });
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    expect(await r.closed).toBe(4000);
  });

  it('invalid messages are answered and counted; 50 close the socket (1008)', async () => {
    b = await boot();
    const { code, token } = await createDemoRoom(b);
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    r.send(hello(code, { token }));
    await r.next('welcome');
    for (let i = 0; i < 30; i++) r.send({ t: 'nope', i });
    await until(() => r.of('error').length >= 30);
    expect(r.of('error').every((e) => e.code === 'invalid')).toBe(true);
    // (the overall bucket refills at 40/s)
    await sleep(800);
    for (let i = 0; i < 25; i++) r.send('not json');
    expect(await r.closed).toBe(1008);
  });

  it('per-connection buckets: a burst over a type limit is dropped with error rate; 200 drops close (1008)', async () => {
    b = await boot();
    const { code, token } = await createDemoRoom(b);
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    r.send(hello(code, { token }));
    await r.next('welcome');
    for (let i = 0; i < 10; i++) r.send({ t: 'presence', state: 'playing' });
    await until(() => r.of('error').length >= 6);
    expect(r.of('error').every((e) => e.code === 'rate')).toBe(true);
    for (let i = 0; i < 260; i++) r.send({ t: 'hash', n: 10, h: '0123456789abcdef' });
    expect(await r.closed).toBe(1008);
  });

  it('ConnBuckets: the overall bucket and per-type buckets refill with time', () => {
    const k = new ConnBuckets(0);
    let ok = 0;
    for (let i = 0; i < 5; i++) if (k.take('chat', 0)) ok++;
    expect(ok).toBe(1);
    expect(k.take('chat', 1000)).toBe(true);
    let all = 0;
    for (let i = 0; i < 60; i++) if (k.take('input', 2000)) all++;
    expect(all).toBe(40);
  });

  it('backpressure: a send that leaves more than the limit buffered closes with 1009 and drops the socket', () => {
    const calls: string[] = [];
    let buffered = 0;
    const fake: WsLike = {
      readyState: 1,
      get bufferedAmount() {
        return buffered;
      },
      send: (d) => {
        buffered += d.length;
        calls.push('send');
      },
      close: (code) => calls.push(`close ${code}`),
      terminate: () => calls.push('terminate'),
    };
    const conn = wsConn(fake, 100);
    const msg: ServerMsg = { t: 'error', code: 'rate', message: 'x'.repeat(40) };
    conn.send(msg);
    expect(calls).toEqual(['send']);
    conn.send(msg);
    expect(calls).toEqual(['send', 'send', 'close 1009', 'terminate']);
  });
});

describe('rooms: HTTP routes', () => {
  it('list, info, create from a demo, 404s', async () => {
    b = await boot();
    expect((await getJson(`${b.base}/api/rooms`)).json).toEqual({ rooms: [], max: 10 });
    const { code, token } = await createDemoRoom(b);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const list = (await getJson(`${b.base}/api/rooms`)).json;
    expect(list.rooms).toHaveLength(1);
    expect(list.rooms[0]).toMatchObject({ code, phase: 'lobby', players: 1, maxPlayers: 8, joinable: true });
    expect((await getJson(`${b.base}/api/rooms/${code}`)).json).toMatchObject({ code });
    expect((await getJson(`${b.base}/api/rooms/${code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'}`)).status).toBe(404);
    expect((await getJson(`${b.base}/api/rooms/bad!`)).status).toBe(404);
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, demo: 'no-such-world' })).json.error.kind).toBe('no_demo');
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE })).status).toBe(400);
    expect((await postJson(`${b.base}/api/rooms`, 'not json')).status).toBe(400);
  });

  it('409 outdated (with reload) before anything else, also from a listed origin with CORS', async () => {
    b = await boot({ allowedOrigins: ['https://any.dv8.no'] });
    const r = await postJson(`${b.base}/api/rooms`, { engine: 'old', world: 'garbage' }, { origin: 'https://any.dv8.no' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ kind: 'outdated', reload: true });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://any.dv8.no');
  });

  it('room limit: 503 server_full', async () => {
    b = await boot({ maxRooms: 1 });
    await createDemoRoom(b);
    const r = await postJson(`${b.base}/api/rooms`, { engine: ENGINE, demo: 'fixture-western' });
    expect(r.status).toBe(503);
    expect(r.json.error.kind).toBe('server_full');
  });

  it('creations per IP count invalid uploads; list calls per IP', async () => {
    b = await boot({ limits: { createsPer10Min: 2, listPerMin: 2 } });
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: { meta: 'nope' } })).status).toBe(400);
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: { meta: 'nope' } })).status).toBe(400);
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, demo: 'fixture-western' })).status).toBe(429);
    expect((await getJson(`${b.base}/api/rooms`)).status).toBe(200);
    expect((await getJson(`${b.base}/api/rooms/ABCD`)).status).toBe(404);
    expect((await getJson(`${b.base}/api/rooms`)).status).toBe(429);
  });

  it('uploads: strict parseWorld, a nesting guard, a 1 MB body, and the first-area timing cap', async () => {
    b = await boot();
    const w = western();
    const ok = await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: w, options: { maxPlayers: 4 } });
    expect(ok.status).toBe(201);
    expect((await getJson(`${b.base}/api/rooms/${ok.json.code}`)).json).toMatchObject({ maxPlayers: 4, world: { title: (w.meta as { title: string }).title } });
    const extra = await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: { ...w, surprise: 1 } });
    expect(extra.status).toBe(400);
    expect(extra.json.error.kind).toBe('invalid_world');
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: deep })).status).toBe(400);
    expect((await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: 'x'.repeat(LIMITS.roomBodyBytes) })).status).toBe(413);
    await b.stop();
    b = await boot({ limits: { firstAreaMs: 0 } });
    const slow = await postJson(`${b.base}/api/rooms`, { engine: ENGINE, world: w });
    expect(slow.status).toBe(400);
    expect(slow.json.error.message).toMatch(/first area/);
    expect((await getJson(`${b.base}/api/rooms`)).json.rooms).toHaveLength(0);
  });

  it('POST /api/rooms/:code/world: the host token in the body, lobby only', async () => {
    b = await boot();
    const { code, token } = await createDemoRoom(b, 'fixture-ship');
    const w = western();
    expect((await postJson(`${b.base}/api/rooms/${code}/world`, { token: 'B'.repeat(22), world: w })).json.error.kind).toBe('bad_token');
    // the host connects first (a seat that joins while the host is off would become host)
    const host = await openRaw(b.wsUrl, { origin: b.origin });
    host.send(hello(code, { token }));
    await host.next('welcome');
    const r = await openRaw(b.wsUrl, { origin: b.origin });
    r.send(hello(code, { name: 'Guest' }));
    const guest = (await r.next('welcome')).you.token;
    expect((await postJson(`${b.base}/api/rooms/${code}/world`, { token: guest, world: w })).json.error.kind).toBe('not_host');
    const up = await postJson(`${b.base}/api/rooms/${code}/world`, { token, world: w });
    expect(up.status).toBe(200);
    expect((await getJson(`${b.base}/api/rooms/${code}`)).json.world.title).toBe((w.meta as { title: string }).title);
    // playing: refused
    host.send({ t: 'start' });
    await host.next('run');
    expect((await postJson(`${b.base}/api/rooms/${code}/world`, { token, world: w })).status).toBe(409);
    expect((await postJson(`${b.base}/api/rooms/ZZZZ/world`, { token, world: w })).status).toBe(404);
  });
});
