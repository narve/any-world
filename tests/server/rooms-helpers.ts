/**
 * Shared helpers for the socket-level room tests: a server with rooms on port 0 and a temp data dir,
 * raw ws clients that record what they get, and a RoomClient over `ws`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { REPO_ROOT } from '../../server/engine-version';
import { startServer, type StartedServer } from '../../server/index';
import type { RoomLimits } from '../../server/rooms/limits';
import type { RoomTiming } from '../../server/rooms/timing';
import { RoomClient, type RoomClientOptions, type RoomSocket } from '../../src/net/client';
import { PLAYER_COLOURS, PROTOCOL, type ServerMsg } from '../../src/net/protocol';

export const ENGINE = 'v-test';

/** fast room timing for socket tests (design §11) */
export const FAST: Partial<RoomTiming> = { travelMs: 20, countdownTurnMs: 50, helloTimeoutMs: 2000 };

export interface Booted {
  s: StartedServer;
  base: string;
  wsUrl: string;
  origin: string;
  dataDir: string;
  logs: string[];
  stop(): Promise<void>;
}

export async function boot(
  o: { limits?: Partial<RoomLimits>; allowedOrigins?: string[]; trustProxy?: number; timing?: Partial<RoomTiming>; maxRooms?: number } = {},
): Promise<Booted> {
  const dataDir = mkdtempSync(join(tmpdir(), 'anyworld-rooms-'));
  const logs: string[] = [];
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    // (the GM off: the room tests keep MP2's offline entries; tests/server/rooms-gm.test.ts turns it on)
    env: { ANYWORLD_GM_PRESET: 'off' },
    recordings: [],
    log: (l) => logs.push(l),
    engineVersion: ENGINE,
    allowedOrigins: o.allowedOrigins ?? [],
    ...(o.trustProxy !== undefined ? { trustProxy: o.trustProxy } : {}),
    rooms: { dataDir, timing: { ...FAST, ...o.timing }, ...(o.limits ? { limits: o.limits } : {}), ...(o.maxRooms ? { maxRooms: o.maxRooms } : {}) },
  });
  return {
    s,
    base: `http://127.0.0.1:${s.port}`,
    wsUrl: `ws://127.0.0.1:${s.port}/api/ws`,
    origin: `http://127.0.0.1:${s.port}`,
    dataDir,
    logs,
    async stop() {
      await s.close(200);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

export async function createDemoRoom(b: Booted, demo = 'fixture-western'): Promise<{ code: string; token: string }> {
  const r = await postJson(`${b.base}/api/rooms`, { engine: ENGINE, demo });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** a raw ws client that records every message and how it closed */
export interface Raw {
  ws: WebSocket;
  msgs: ServerMsg[];
  /** resolves with the close code */
  closed: Promise<number>;
  send(v: unknown): void;
  /** waits for a message of type t (already received ones count) */
  next<T extends ServerMsg['t']>(t: T, ms?: number): Promise<Extract<ServerMsg, { t: T }>>;
  of<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[];
}

/** opens a socket; resolves when it is open, rejects with the HTTP status of a refused upgrade */
export function openRaw(url: string, headers: Record<string, string> = {}, opts: { autoPong?: boolean } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, ...(opts.autoPong === false ? { autoPong: false } : {}) });
    const msgs: ServerMsg[] = [];
    const waiters: (() => void)[] = [];
    let closeCode: (c: number) => void = () => {};
    const closed = new Promise<number>((r) => (closeCode = r));
    ws.on('message', (d) => {
      msgs.push(JSON.parse(String(d)) as ServerMsg);
      for (const w of waiters.splice(0)) w();
    });
    ws.on('close', (code) => closeCode(code));
    ws.on('error', (e) => {
      const m = /Unexpected server response: (\d+)/.exec(String(e.message));
      reject(Object.assign(new Error(e.message), { status: m ? Number(m[1]) : 0 }));
    });
    const of = <T extends ServerMsg['t']>(t: T) => msgs.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
    ws.on('open', () =>
      resolve({
        ws,
        msgs,
        closed,
        send: (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v)),
        of,
        next: (t, ms = 3000) =>
          new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`no ${t} within ${ms} ms (got ${msgs.map((m) => m.t).join(',')})`)), ms);
            const check = () => {
              const hit = of(t)[0];
              if (hit) {
                clearTimeout(timer);
                res(hit);
              } else waiters.push(check);
            };
            check();
          }),
      }),
    );
  });
}

/** the status of a refused upgrade (0 when it was accepted, after closing it again) */
export async function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  try {
    const r = await openRaw(url, headers);
    r.ws.close();
    await r.closed;
    return 101;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

export function hello(room: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'hello', v: PROTOCOL, engine: ENGINE, room, name: 'Tester', colour: PLAYER_COLOURS[0], ...extra };
}

/** a RoomClient over ws with the given Origin */
export function wsClient(b: Booted, o: Omit<RoomClientOptions, 'url' | 'socket' | 'engine'> & { engine?: string }): RoomClient {
  return new RoomClient({
    url: b.wsUrl,
    socket: (url) => new WebSocket(url, { headers: { origin: b.origin } }) as unknown as RoomSocket,
    engine: ENGINE,
    ...o,
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** polls `cond` every 10 ms until it holds or `ms` pass */
export async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** a port that was free a moment ago (a restarted child server binds the same one, so clients reconnect) */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => res(port));
    });
  });
}

export interface Spawned {
  proc: ChildProcess;
  port: number;
  out: string[];
}

/**
 * A TypeScript entry point run by node with the tsx loader in one process, so its PID is the program's
 * (the tsx binary runs the program in a second process and cannot pass SIGKILL on, leaving it behind).
 */
export function spawnTs(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The server entry point as a child process (server/index.ts, PORT=0 unless given), resolved once
 * it prints `listening <port>`; rejects with the exit code when it exits first. NODE_ENV,
 * STATE_DIRECTORY and ALLOWED_ORIGINS are removed from the environment it gets, and ANYWORLD_GM_PRESET is
 * off unless `env` sets it. `onSpawn` receives
 * the process at once, so a test can kill it by PID in afterEach even when the start fails.
 */
export function spawnServer(env: Record<string, string>, onSpawn: (p: ChildProcess) => void): Promise<Spawned> {
  // (the GM off unless the test asks for it: never a real provider from the developer's environment)
  const env2: Record<string, string | undefined> = { ...process.env, PORT: '0', HOST: '127.0.0.1', ANYWORLD_GM_PRESET: 'off', ...env };
  delete env2.NODE_ENV;
  delete env2.STATE_DIRECTORY;
  delete env2.ALLOWED_ORIGINS;
  const p = spawnTs(['server/index.ts'], env2 as NodeJS.ProcessEnv);
  onSpawn(p);
  const out: string[] = [];
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no listening line: ${out.join('')}`)), 20_000);
    p.stdout!.on('data', (d: Buffer) => {
      out.push(d.toString());
      const m = /\[server\] listening (\d+)/.exec(out.join(''));
      if (m) {
        clearTimeout(timer);
        res({ proc: p, port: Number(m[1]), out });
      }
    });
    p.stderr!.on('data', (d: Buffer) => out.push(d.toString()));
    p.on('exit', (code) => {
      clearTimeout(timer);
      rej(Object.assign(new Error(`exited ${code}: ${out.join('')}`), { code, out: out.join('') }));
    });
  });
}

/** resolves with the exit code once the process has exited */
export const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null || p.signalCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));

/** kills a child by PID if it still runs, and waits for it to exit */
export async function killChild(p: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null || !p.pid) return;
  const done = exited(p);
  process.kill(p.pid, signal);
  await done;
}
