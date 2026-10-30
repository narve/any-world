/**
 * MP2 exit checks (design §11): scripted clients (tools/rooms/scripted-client.ts) against a real
 * server over real sockets.
 *  - play: 4 bots chat and play ~150 entries and on to an area change; every replica, the chat and
 *    the GM entries agree with the server
 *  - restart: a child server is SIGKILLed mid-run; its files replay to the clients' state, it is
 *    restarted on the same port and data dir, the clients reconnect with their tokens and play on
 *  - version: a restart with another engine version closes the room; the old page is told to reload,
 *    a reloaded one that the room was closed for an update
 *  - outdated: an old engine is refused with reload (also with an otherwise invalid hello), and
 *    POST /api/rooms answers 409
 *  - reconnect: a dropped client is away (not waited for, not targeted) and comes back as the same pid
 *  - faults: delay, jitter, stalls, random closes and lost inputs; every client ends on the server hash
 *  - bots: tools/room-bots.ts against a child server with the computed engine version
 * One sequential file; child servers are killed by PID in afterEach, also when a test fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, hashState } from '../../src/engine/index';
import type { GameEvent } from '../../src/engine/types';
import { applyEntries } from '../../src/net/log';
import { noticeFor } from '../../src/net/messages';
import { PLAYER_COLOURS, REFUSED_CLOSE, type LogEntry } from '../../src/net/protocol';
import { RoomStore, linesToReplay } from '../../server/rooms/store';
import type { Room } from '../../server/rooms/room';
import { ScriptedClient, type FaultOptions } from '../../tools/rooms/scripted-client';
import type { BotName } from '../../src/engine/sim/bots';
import { boot, ENGINE, freePort, getJson, hello, killChild, openRaw, postJson, spawnServer, spawnTs, until, type Booted } from './rooms-helpers';

const BOTS: BotName[] = ['explorer', 'cautious', 'talker', 'newbie'];
/** socket-test timing (design §11): deadline 300 ms, travel 20 ms, countdown turn 50 ms */
const TIMING = { travelMs: 20, countdownTurnMs: 50, deadlineMs: 300, helloTimeoutMs: 3000 };
const CHILD_TIMING = JSON.stringify(TIMING);

let b: Booted | undefined;
const clients: ScriptedClient[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await b?.stop();
  b = undefined;
  for (const p of children.splice(0)) await killChild(p);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anyworld-exit-'));
  dirs.push(d);
  return d;
}

const child = (env: Record<string, string>) => spawnServer(env, (p) => children.push(p));

interface Target {
  wsUrl: string;
  base: string;
  origin: string;
}

const targetOf = (port: number): Target => ({ wsUrl: `ws://127.0.0.1:${port}/api/ws`, base: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` });

function scripted(t: Target, room: string, i: number, o: { token?: string; engine?: string; chatEvery?: number; fault?: FaultOptions } = {}): ScriptedClient {
  const c = new ScriptedClient({
    url: t.wsUrl,
    origin: t.origin,
    room,
    name: `Bot ${i + 1}`,
    colour: PLAYER_COLOURS[i],
    engine: o.engine ?? ENGINE,
    bot: BOTS[i % BOTS.length],
    seed: 100 + i,
    retryMs: 600,
    ...(o.token ? { token: o.token } : {}),
    ...(o.chatEvery ? { chatEvery: o.chatEvery } : {}),
    ...(o.fault ? { fault: o.fault } : {}),
  });
  clients.push(c);
  return c;
}

async function createRoom(t: Target, engine = ENGINE): Promise<{ code: string; token: string }> {
  const r = await postJson(`${t.base}/api/rooms`, { engine, demo: 'fixture-western' }, { origin: t.origin });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** a room with `count` scripted clients joined (the creator first, so it is the host) and the run started */
async function party(t: Target, count: number, o: { engine?: string; chatEvery?: number; fault?: (i: number) => FaultOptions } = {}) {
  const { code, token } = await createRoom(t, o.engine);
  const cs: ScriptedClient[] = [];
  for (let i = 0; i < count; i++) {
    const c = scripted(t, code, i, { ...(i === 0 ? { token } : {}), ...(o.engine ? { engine: o.engine } : {}), ...(o.chatEvery ? { chatEvery: o.chatEvery } : {}), ...(o.fault ? { fault: o.fault(i) } : {}) });
    await c.connect();
    cs.push(c);
  }
  expect(cs[0].client.host).toBe(true);
  cs[0].client.start();
  await until(() => cs.every((c) => !!c.state && !!c.pid), 10_000, 'the run on every client');
  return { code, token, cs };
}

/** every client joined and at the same n (and at the room's, when there is one) */
async function settled(cs: ScriptedClient[], room?: Room, ms = 15_000): Promise<void> {
  await until(() => cs.every((c) => c.client.status === 'joined' && c.n === (room ? room.n : cs[0].n)), ms, `the clients at one n (${cs.map((c) => `${c.client.status}:${c.n}`).join(' ')}${room ? ` room ${room.n}` : ''})`);
}

const pause = (cs: ScriptedClient[]) => cs.forEach((c) => c.pause());

/** the entries every client has, as one list per client (n from 0, no gaps when no snapshot came) */
function contiguous(es: readonly LogEntry[]): boolean {
  return es.every((e, i) => e.n === i);
}

describe('MP2 exit checks (tests in a file run one after another)', { timeout: 240_000 }, () => {
  it('play: 4 clients chat and play to an area change, and agree with the server', async () => {
    b = await boot({ timing: TIMING });
    const t: Target = b;
    const { code, cs } = await party(t, 4, { chatEvery: 25 });
    const room = b.s.rooms!.get(code)!;
    // ~150 entries, and on until the party reaches the next area (capped)
    await Promise.all(cs.map((c) => c.playUntil(() => room.n >= 150 && (room.state!.area.index > 0 || room.n >= 900))));
    pause(cs);
    await settled(cs, room);
    expect(room.n).toBeGreaterThanOrEqual(150);
    const h = hashState(room.state!);
    for (const c of cs) {
      expect(hashState(c.state!), c.opts.name).toBe(h);
      expect(c.desyncs).toBe(0);
      expect(c.snapshots).toBe(0);
      expect(c.faults).toEqual([]);
      expect(contiguous(c.entries)).toBe(true);
    }
    // the entries every client applied are the server's (the ring holds the last 512)
    const ring = room.recentEntries();
    expect(cs[1].entries.slice(-ring.length)).toEqual(ring.slice(-cs[1].entries.length));
    expect(room.state!.area.index, 'an area change').toBeGreaterThan(0);
    // chat: everyone has the server's history, in order
    expect(room.chat.length).toBeGreaterThanOrEqual(4);
    expect(room.chat.length).toBeLessThanOrEqual(100);
    for (const c of cs) expect(c.chats).toEqual(room.chat);
    expect(room.chat.map((l) => l.id)).toEqual([...room.chat.map((l) => l.id)].sort((x, y) => x - y));
    // typing made the seats busy (turn entries with busy: true), and the canned GM spoke
    const es = cs[0].entries;
    expect(es.some((e) => e.k === 'turn' && e.inputs.some((i) => i.busy === true))).toBe(true);
    expect(es.some((e) => e.k === 'gm' && (e.hook === 'intro' || e.hook === 'area_enter'))).toBe(true);
    expect(es.some((e) => e.k === 'gm' && e.hook === 'area_enter')).toBe(true);
  });

  it('restart: a killed server replays its log, and the clients reconnect with their tokens', async () => {
    const dir = tempDir();
    const port = await freePort();
    const env = { PORT: String(port), ANYWORLD_DATA_DIR: dir, ANYWORLD_ENGINE_VERSION: ENGINE, ANYWORLD_TEST_TIMING: CHILD_TIMING };
    const first = await child(env);
    const t = targetOf(first.port);
    const { code, cs } = await party(t, 3);
    await Promise.all(cs.map((c) => c.play(60)));
    // kill -9 mid-run, with the bots still playing
    await killChild(first.proc, 'SIGKILL');
    pause(cs);
    await until(() => cs.every((c) => c.client.status === 'reconnecting'), 5000, `the clients reconnecting (${cs.map((c) => c.client.status)})`);
    // the files replay to what the clients saw: append before broadcast, so the log holds every entry a client got
    const loaded = new RoomStore(join(dir, 'rooms')).load(code);
    const replay = linesToReplay(loaded.room, loaded.lines);
    const world = loaded.world.world;
    const snap = loaded.room.snapshot!;
    const diskN = snap.n + replay.entries.length;
    const fromDisk = applyEntries(world, deserialize(world, snap.state), replay.entries);
    const best = cs.reduce((x, y) => (y.n > x.n ? y : x));
    expect(diskN).toBeGreaterThanOrEqual(best.n);
    for (const c of cs) {
      expect(contiguous(c.entries)).toBe(true);
      expect(replay.entries.filter((e) => e.n < c.n)).toEqual(c.entries.slice(snap.n));
    }
    // against an uninterrupted run of the same entries from the run's start
    const recorded = best.entries.slice();
    const uninterrupted = applyEntries(world, best.runStart!, recorded);
    expect(hashState(uninterrupted)).toBe(hashState(best.state!));
    if (diskN === best.n) expect(hashState(fromDisk)).toBe(hashState(uninterrupted));

    // the same port and data dir: the clients come back by themselves
    const second = await child(env);
    expect(second.out.join('')).toContain('rooms in');
    await until(() => cs.every((c) => c.client.status === 'joined' && c.reconnects >= 1), 15_000, 'the reconnects');
    for (const [i, c] of cs.entries()) expect(c.pid).toBe(`p${i + 1}`);
    await settled(cs);
    // they caught up with entries (no snapshot): the replayed state, then only the seats' away / back
    for (const c of cs) {
      expect(c.snapshots).toBe(0);
      expect(contiguous(c.entries)).toBe(true);
      expect(hashState(applyEntries(world, c.runStart!, c.entries.slice(0, diskN)))).toBe(hashState(fromDisk));
      expect(c.entries.slice(diskN).filter((e) => e.k !== 'away' && e.k !== 'back')).toEqual([]);
    }
    await Promise.all(cs.map((c) => c.play(50)));
    pause(cs);
    await settled(cs);
    // a graceful stop snapshots: the stored state is the clients'. The server appends and sends
    // before its snapshot, and an input sent before pause() may still resolve at its deadline, so
    // n and the hash are taken together once every client has seen the socket close (MP5: the race)
    await killChild(second.proc, 'SIGTERM');
    await until(() => cs.every((c) => c.client.status !== 'joined'), 10_000, 'the closes');
    const n = cs[0].n;
    const h = hashState(cs[0].state!);
    for (const c of cs) {
      expect([c.n, hashState(c.state!)]).toEqual([n, h]);
      expect(c.desyncs).toBe(0);
    }
    const after = new RoomStore(join(dir, 'rooms')).load(code);
    expect(after.room.snapshot!.n).toBe(n);
    expect(hashState(deserialize(world, after.room.snapshot!.state))).toBe(h);
  });

  it('version: a deploy with a new engine version closes the room with a toast', async () => {
    const dir = tempDir();
    const port = await freePort();
    const env = { PORT: String(port), ANYWORLD_DATA_DIR: dir, ANYWORLD_TEST_TIMING: CHILD_TIMING };
    const first = await child({ ...env, ANYWORLD_ENGINE_VERSION: 'v-one' });
    const t = targetOf(first.port);
    const { code, token, cs } = await party(t, 2, { engine: 'v-one' });
    await Promise.all(cs.map((c) => c.play(20)));
    pause(cs);
    await killChild(first.proc, 'SIGTERM');
    expect(existsSync(join(dir, 'rooms', `${code}.json`))).toBe(true);
    const second = await child({ ...env, ANYWORLD_ENGINE_VERSION: 'v-two' });
    expect(second.out.join('')).toContain('engine version v-two');
    // the room files are gone and the list is empty
    expect(existsSync(join(dir, 'rooms', `${code}.json`))).toBe(false);
    expect((await getJson(`${t.base}/api/rooms`)).json.rooms).toEqual([]);
    // the open pages reconnect with the old engine: refused, reload
    await until(() => cs.every((c) => c.client.status === 'stopped'), 15_000, 'the old pages refused');
    for (const c of cs) expect(c.notices).toEqual([{ key: 'net.outdated', reload: true }]);
    // a reloaded page (the new engine, the old token): the room was closed for the update
    const reloaded = scripted(t, code, 0, { token, engine: 'v-two' });
    const e = (await reloaded.connect().catch((x: unknown) => x)) as Error;
    expect(e.message).toBe('net.serverUpdated');
    expect(reloaded.notices).toEqual([{ key: 'net.serverUpdated', reload: false }]);
    const raw = await openRaw(t.wsUrl, { origin: t.origin });
    raw.send(hello(code, { engine: 'v-two', token }));
    const refused = await raw.next('refused');
    expect(refused).toMatchObject({ code: 'room_closed', reason: 'server_updated' });
    expect(noticeFor(refused).key).toBe('net.serverUpdated');
    expect(await raw.closed).toBe(REFUSED_CLOSE.room_closed);
  });

  it('outdated: an old page is refused with a reload, also with an invalid hello, and POST answers 409', async () => {
    const pages = 'https://pages.example';
    b = await boot({ timing: TIMING, allowedOrigins: [pages] });
    const { code } = await createRoom({ ...b, origin: pages });
    const raw = await openRaw(b.wsUrl, { origin: pages });
    raw.send(hello(code, { engine: 'old' }));
    const r1 = await raw.next('refused');
    expect(r1).toMatchObject({ code: 'outdated', reload: true });
    expect(noticeFor(r1)).toEqual({ key: 'net.outdated', reload: true });
    expect(await raw.closed).toBe(REFUSED_CLOSE.outdated);
    // the version is read before anything else in the hello is validated
    const raw2 = await openRaw(b.wsUrl, { origin: pages });
    raw2.send({ t: 'hello', v: 99, engine: 'old', room: 'not a code', name: '', colour: 'pink' });
    expect(await raw2.next('refused')).toMatchObject({ code: 'outdated', reload: true });
    expect(await raw2.closed).toBe(REFUSED_CLOSE.outdated);
    // a RoomClient gets the toast's key
    const old = scripted({ ...b, origin: pages }, code, 1, { engine: 'old' });
    expect(((await old.connect().catch((x: unknown) => x)) as Error).message).toBe('net.outdated');
    expect(old.notices).toEqual([{ key: 'net.outdated', reload: true }]);
    // creating a room from the listed origin with an old page
    const post = await postJson(`${b.base}/api/rooms`, { engine: 'old', demo: 'fixture-western' }, { origin: pages });
    expect(post.status).toBe(409);
    expect(post.json.error).toMatchObject({ kind: 'outdated', reload: true });
  });

  it('reconnect: a dropped client is away, not waited for nor targeted, and returns as the same pid', async () => {
    b = await boot({ timing: TIMING });
    const { code, cs } = await party(b, 3);
    const room = b.s.rooms!.get(code)!;
    await Promise.all(cs.map((c) => c.play(15)));
    const [a, gone, c3] = cs;
    gone.pause();
    gone.drop({ stay: true });
    const pid = gone.pid!;
    await until(() => a.client.roster.find((s) => s.seat === gone.client.seat)?.presence === 'off', 3000, 'the roster off');
    await until(() => a.entries.some((e) => e.k === 'away' && e.pid === pid), 3000, 'the away entry');
    const awayAt = a.entries.findIndex((e) => e.k === 'away' && e.pid === pid);
    const actor = a.state!.players[pid].actorId;
    // the others play on without it; hostiles leave it alone
    const events: GameEvent[] = [];
    const targeted: string[] = [];
    let turnsSinceAway = 0;
    const off = a.client.on((e) => {
      if (e.t !== 'entries') return;
      events.push(...e.events);
      turnsSinceAway += e.entries.filter((x) => x.k === 'turn' && x.advance).length;
      // a hostile may keep its target until its next decision: look from the second turn on
      if (turnsSinceAway >= 2) for (const h of a.state!.area.actors) if (h.faction === 'hostile' && h.hp > 0 && h.ai.targetId === actor) targeted.push(h.id);
    });
    const n0 = room.n;
    const turn0 = room.state!.turn;
    await Promise.all([a, c3].map((c) => c.playUntil(() => room.n >= n0 + 30)));
    off();
    expect(room.n).toBeGreaterThanOrEqual(n0 + 30);
    expect(room.state!.turn).toBeGreaterThan(turn0 + 5);
    expect(room.state!.players[pid].away).toBe(true);
    expect(targeted).toEqual([]);
    expect(events.filter((e) => e.type === 'attacked' && e.targetId === actor)).toEqual([]);
    expect(a.entries.slice(awayAt).some((e) => e.k === 'leave')).toBe(false);
    // back: the same pid, a back entry, and the replica catches up
    pause([a, c3]);
    const w = await gone.reconnect();
    expect(w.you.pid).toBe(pid);
    expect(gone.pid).toBe(pid);
    await until(() => a.entries.some((e, i) => i > awayAt && e.k === 'back' && e.pid === pid), 3000, 'the back entry');
    await settled(cs, room);
    expect(room.state!.players[pid].away).toBeFalsy();
    for (const c of cs) expect(hashState(c.state!)).toBe(hashState(room.state!));
    expect(gone.reconnects).toBe(1);
    expect(gone.snapshots).toBe(0);
  });

  it('faults: delay, jitter, stalls, random closes and lost inputs; every client ends on the server hash', async () => {
    b = await boot({ timing: TIMING });
    const { code, cs } = await party(b, 4, {
      chatEvery: 30,
      fault: (i) => ({ delayMs: [20, 250], stallEvery: 80, stallMs: 600, closeEvery: 150, dropInputs: 0.05, seed: 7 + i }),
    });
    const room = b.s.rooms!.get(code)!;
    await Promise.all(cs.map((c) => c.playUntil(() => room.n >= 100)));
    pause(cs);
    await settled(cs, room, 30_000);
    const h = hashState(room.state!);
    const stats = cs.map((c) => c.channel!.stats);
    for (const c of cs) {
      expect(hashState(c.state!), c.opts.name).toBe(h);
      expect(c.faults.filter((f) => f.startsWith('bot') || f.startsWith('world'))).toEqual([]);
    }
    const sum = (k: keyof (typeof stats)[number]) => stats.reduce((x, s) => x + s[k], 0);
    expect(sum('droppedInputs'), 'lost inputs').toBeGreaterThan(0);
    expect(sum('stalls'), 'stalls').toBeGreaterThan(0);
    expect(sum('closes'), 'socket closes').toBeGreaterThan(0);
    expect(cs.reduce((x, c) => x + c.reconnects, 0)).toBeGreaterThanOrEqual(sum('closes'));
    // the turns went on although inputs were lost: some resolved without a ready, connected player's action
    const missing = room.recentEntries().filter((e): e is Extract<LogEntry, { k: 'turn' }> => e.k === 'turn' && e.advance).filter((e) => e.inputs.filter((i) => i.actions?.length).length < cs.length);
    expect(missing.length).toBeGreaterThan(0);
    console.log(`[faults] n=${room.n} ${JSON.stringify(stats)} reconnects=${cs.map((c) => c.reconnects)} snapshots=${cs.map((c) => c.snapshots + c.desyncs)}`);
  });

  it('bots: tools/room-bots.ts plays against a child server with the computed engine version', async () => {
    const dir = tempDir();
    const env: Record<string, string> = { ANYWORLD_DATA_DIR: dir, ANYWORLD_TEST_TIMING: CHILD_TIMING };
    const srv = await child(env);
    const health = await getJson(`http://127.0.0.1:${srv.port}/api/health`);
    expect(health.json.engine).not.toBe('dev');
    expect(health.json.engine).toMatch(/^[0-9a-f]{16}$/);
    const out: string[] = [];
    const env2: Record<string, string | undefined> = { ...process.env };
    delete env2.ANYWORLD_ENGINE_VERSION;
    delete env2.NODE_ENV;
    const p = spawnTs(['tools/room-bots.ts', '--url', `http://127.0.0.1:${srv.port}`, '--bots', '3', '--entries', '60', '--timeout', '120'], env2 as NodeJS.ProcessEnv);
    children.push(p);
    p.stdout!.on('data', (d: Buffer) => out.push(d.toString()));
    p.stderr!.on('data', (d: Buffer) => out.push(d.toString()));
    const code = await new Promise<number | null>((r) => p.once('exit', (c) => r(c)));
    const text = out.join('');
    expect(code, text).toBe(0);
    expect(text).toMatch(/\[room-bots\] ok room [2-9A-HJ-NP-Z]{4} n=\d+/);
    expect(text).toContain('desyncs=0');
  });
});
