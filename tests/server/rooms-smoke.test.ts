/**
 * MP2 C4: a smoke run over real sockets. Two RoomClients (src/net/client.ts over `ws`) join a demo
 * room, the host starts, both play a few turns and chat, a dropped socket reconnects with its token
 * and catches up, and every replica ends on the server's hash. Then the real entry point as a child
 * process: the `listening <port>` line, ANYWORLD_ENGINE_VERSION / ANYWORLD_TEST_TIMING, graceful
 * shutdown (snapshot + bye) on SIGTERM, and the refusal to start without a usable data directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashState } from '../../src/engine/index';
import type { RoomClient } from '../../src/net/client';
import { PLAYER_COLOURS } from '../../src/net/protocol';
import { REPO_ROOT } from '../../server/engine-version';
import { boot, createDemoRoom, hello, openRaw, postJson, until, wsClient, type Booted } from './rooms-helpers';

let b: Booted | undefined;
const clients: RoomClient[] = [];
let child: ChildProcess | undefined;
let childDir: string | undefined;

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await b?.stop();
  b = undefined;
  if (child && child.exitCode === null && child.pid) process.kill(child.pid, 'SIGKILL');
  child = undefined;
  if (childDir) rmSync(childDir, { recursive: true, force: true });
  childDir = undefined;
});

/** one turn for every client: a wait, then until the server has applied it */
async function playTurn(cs: RoomClient[], b: Booted, code: string): Promise<void> {
  const room = b.s.rooms!.get(code)!;
  const before = room.state!.turn;
  for (const c of cs) expect(c.input([{ type: 'wait' }], 'decide')).toBe(true);
  await until(() => room.state!.turn > before && cs.every((c) => c.n === room.n), 3000, 'the turn');
}

describe('rooms: smoke over a real socket', () => {
  it('two clients join, play, chat, reconnect, and agree with the server', async () => {
    b = await boot();
    const { code, token } = await createDemoRoom(b);
    const host = wsClient(b, { room: code, token, name: 'Ann', colour: PLAYER_COLOURS[0] });
    const guest = wsClient(b, { room: code, name: 'Bo', colour: PLAYER_COLOURS[1] });
    clients.push(host, guest);
    host.connect();
    const w1 = await host.joined();
    expect(w1.you).toMatchObject({ seat: 's1', host: true });
    guest.connect();
    const w2 = await guest.joined();
    expect(w2.you.host).toBe(false);
    expect(w2.world).toBeDefined();
    expect(guest.worldId).toBe(w2.worldId);

    host.start();
    await until(() => !!host.state && !!guest.state, 3000, 'the run');
    expect(host.pid).toBe('p1');
    expect(guest.pid).toBe('p2');
    const room = b.s.rooms!.get(code)!;
    for (let i = 0; i < 4; i++) await playTurn([host, guest], b, code);
    expect(hashState(host.state!)).toBe(hashState(room.state!));
    expect(hashState(guest.state!)).toBe(hashState(room.state!));

    host.say('hello there');
    await until(() => guest.chat.some((l) => l.text === 'hello there'), 2000, 'the chat line');
    expect(guest.chat.at(-1)).toMatchObject({ name: 'Ann', seat: 's1' });

    // a dropped socket: the guest goes away, the host plays on, the guest comes back and catches up
    guest.drop();
    await until(() => room.seatList().find((s) => s.seat === 's2')?.connected === false, 2000, 'the seat off');
    for (let i = 0; i < 2; i++) await playTurn([host], b, code);
    await until(() => guest.status === 'joined' && guest.reconnects === 1 && guest.n === room.n, 5000, 'the reconnect');
    expect(guest.pid).toBe('p2');
    expect(room.recentEntries().some((e) => e.k === 'away' && e.pid === 'p2')).toBe(true);
    expect(room.recentEntries().some((e) => e.k === 'back' && e.pid === 'p2')).toBe(true);
    await playTurn([host, guest], b, code);
    for (const c of [host, guest]) expect(hashState(c.state!)).toBe(hashState(room.state!));
    expect(host.desyncs + guest.desyncs).toBe(0);
  });
});

/** the server entry point as a child process (tsx), resolved with its port once it prints `listening` */
function spawnServer(env: Record<string, string>): Promise<{ port: number; out: string[] }> {
  const tsx = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
  const env2: Record<string, string | undefined> = { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env };
  delete env2.NODE_ENV;
  delete env2.STATE_DIRECTORY;
  const p = spawn(tsx, ['server/index.ts'], { cwd: REPO_ROOT, env: env2 as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child = p;
  const out: string[] = [];
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no listening line: ${out.join('')}`)), 20_000);
    const onData = (d: Buffer) => {
      out.push(d.toString());
      const m = /\[server\] listening (\d+)/.exec(out.join(''));
      if (m) {
        clearTimeout(timer);
        res({ port: Number(m[1]), out });
      }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', (d: Buffer) => out.push(d.toString()));
    p.on('exit', (code) => {
      clearTimeout(timer);
      rej(Object.assign(new Error(`exited ${code}: ${out.join('')}`), { code, out: out.join('') }));
    });
  });
}

const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));

describe('rooms: the server process', () => {
  it('prints listening <port>, honours the test knobs, and on SIGTERM snapshots and sends bye', async () => {
    childDir = mkdtempSync(join(tmpdir(), 'anyworld-child-'));
    const { port, out } = await spawnServer({ ANYWORLD_DATA_DIR: childDir, ANYWORLD_ENGINE_VERSION: 'v-child', ANYWORLD_TEST_TIMING: '{"travelMs":20}' });
    expect(out.join('')).toContain('engine version v-child');
    const base = `http://127.0.0.1:${port}`;
    const created = await postJson(`${base}/api/rooms`, { engine: 'v-child', demo: 'fixture-western' });
    expect(created.status).toBe(201);
    const r = await openRaw(`ws://127.0.0.1:${port}/api/ws`, { origin: base });
    r.send(hello(created.json.code, { engine: 'v-child', token: created.json.token }));
    await r.next('welcome');
    r.send({ t: 'start' });
    await r.next('run');
    process.kill(child!.pid!, 'SIGTERM');
    expect((await r.next('bye')).reason).toBe('restart');
    expect(await r.closed).toBe(1012);
    expect(await exited(child!)).toBe(0);
    expect(existsSync(join(childDir, 'rooms', `${created.json.code}.json`))).toBe(true);
  });

  it('refuses to start when the data directory cannot be used', async () => {
    childDir = mkdtempSync(join(tmpdir(), 'anyworld-child-'));
    writeFileSync(join(childDir, 'file'), 'x');
    const e = (await spawnServer({ ANYWORLD_DATA_DIR: join(childDir, 'file') }).catch((x: unknown) => x)) as { code: number; out: string };
    expect(e.code).toBe(1);
    expect(e.out).toContain('cannot use data directory');
  });
});
