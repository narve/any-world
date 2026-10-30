/**
 * MP2 C3: room files (server/rooms/store.ts) and the manager's start-up around them: atomic
 * writes, the world file written once, a torn last log line, snapshot then truncate (and a crash
 * between the two), a broken room moved aside, leftover tmp files, tombstones, and version closing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashState } from '../../src/engine';
import { linesToReplay, RoomStore, TOMBSTONE_MS, writeAtomic, type LogLine, type RoomFile } from '../../server/rooms/store';
import { RoomManager } from '../../server/rooms/manager';
import { ManualScheduler } from '../../server/rooms/timing';
import type { Conn } from '../../server/rooms/room';
import type { ServerMsg } from '../../src/net/protocol';
import { PLAYER_COLOURS } from '../../src/net/protocol';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anyworld-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  closedWith: number | null = null;
  send(m: ServerMsg): void {
    this.msgs.push(JSON.parse(JSON.stringify(m)) as ServerMsg);
  }
  close(code: number): void {
    this.closedWith = code;
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
}

function manager(sch: ManualScheduler, version = 'v1', log: string[] = []) {
  let seed = 41;
  let codes = 0;
  return new RoomManager({
    dir,
    engineVersion: version,
    scheduler: sch,
    log: (l) => log.push(l),
    seed: () => ++seed,
    code: () => ['K7QX', 'M2RP', 'T9WV', 'B4CD'][codes++ % 4],
  });
}

function hello(token: string | undefined, name: string, extra: Record<string, unknown> = {}) {
  return { t: 'hello' as const, v: 1 as const, engine: 'v1', room: 'K7QX', name, colour: PLAYER_COLOURS[0], ...(token ? { token } : {}), ...extra };
}

describe('RoomStore', () => {
  it('writes atomically (no tmp file left) and cleans leftover tmp files', () => {
    const p = join(dir, 'x.json');
    writeAtomic(p, '{"a":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(['x.json']);
    const store = new RoomStore(join(dir, 'rooms'));
    writeFileSync(join(store.dir, 'K7QX.json.tmp'), 'half');
    writeFileSync(join(store.dir, 'closed.json.tmp'), 'half');
    expect(store.cleanTmp()).toBe(2);
    expect(readdirSync(store.dir)).toEqual([]);
  });

  it('skips a torn last line, entries already in the snapshot, other runs and duplicate chat; seat records are last-wins', () => {
    const room = { snapshot: { n: 3, state: '' }, run: 2, seats: [{ seat: 's1', tokenHash: 'h', name: 'A', colour: '#e6194b', pid: 'p1', joinedAt: 0 }], chat: [{ id: 1, seat: 's1', name: 'A', colour: '#e6194b', text: 'hi', at: 0 }] } as unknown as RoomFile;
    const e = (n: number, run = 2) => ({ e: { k: 'away' as const, pid: 'p1', n, run } });
    const lines = [
      e(1),
      e(2),
      e(3),
      e(0, 1),
      e(4),
      { chat: { id: 1, seat: 's1', name: 'A', colour: '#e6194b', text: 'hi', at: 0 } },
      { chat: { id: 2, seat: 's1', name: 'A', colour: '#e6194b', text: 'yo', at: 1 } },
      { seat: { seat: 's1', tokenHash: 'h', name: 'A2', colour: '#e6194b', pid: 'p1', joinedAt: 0 } },
      e(6), // a gap: skipped
    ] as LogLine[];
    const r = linesToReplay(room, lines);
    expect(r.entries.map((x) => x.n)).toEqual([3, 4]);
    expect(r.chat.map((c) => c.id)).toEqual([2]);
    expect(r.seats.map((s) => s.name)).toEqual(['A2']);

    const store = new RoomStore(dir);
    writeFileSync(join(dir, 'K7QX.json'), JSON.stringify({ format: 1, code: 'K7QX' }));
    writeFileSync(join(dir, 'K7QX.world.json'), JSON.stringify({ format: 1 }));
    writeFileSync(join(dir, 'K7QX.log'), `${JSON.stringify(e(0))}\n${JSON.stringify(e(1))}\n{"e":{"k":"aw`);
    expect(store.load('K7QX').lines).toHaveLength(2);
  });

  it('keeps tombstones for 7 days', () => {
    const store = new RoomStore(dir);
    store.addTombstones({ AAAA: { reason: 'idle', at: 0 } }, 0);
    store.addTombstones({ BBBB: { reason: 'server_updated', at: TOMBSTONE_MS - 10 } }, TOMBSTONE_MS - 10);
    expect(Object.keys(store.tombstones(TOMBSTONE_MS - 10)).sort()).toEqual(['AAAA', 'BBBB']);
    expect(Object.keys(store.tombstones(TOMBSTONE_MS + 1))).toEqual(['BBBB']);
    store.addTombstones({}, TOMBSTONE_MS + 1);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'closed.json'), 'utf8')))).toEqual(['BBBB']);
  });
});

describe('RoomManager persistence', () => {
  it('writes the world file once, snapshots then truncates the log, and a restart replays to the same state', () => {
    const sch = new ManualScheduler();
    const m = manager(sch);
    const created = m.create({ demo: 'fixture-western' });
    if (!created.ok) throw new Error(created.error);
    const worldPath = join(dir, 'K7QX.world.json');
    const worldMtime = statSync(worldPath).mtimeMs;
    const a = new FakeConn();
    const room = m.hello(a, hello(created.token, 'Ann'))!;
    const b = new FakeConn();
    m.hello(b, hello(undefined, 'Bo'));
    room.message(a, { t: 'start' });
    expect(room.phase).toBe('playing');
    // run start: a snapshot, the log holds only what came after it (the intro)
    const file = JSON.parse(readFileSync(join(dir, 'K7QX.json'), 'utf8')) as RoomFile;
    expect(file.snapshot?.n).toBe(0);
    expect(file.run).toBe(1);
    const logAfterStart = readFileSync(join(dir, 'K7QX.log'), 'utf8').trim().split('\n').filter(Boolean);
    expect(logAfterStart.every((l) => 'e' in JSON.parse(l))).toBe(true);
    // play some turns: both wait
    for (let i = 0; i < 12; i++) {
      const s = room.state!;
      for (const c of [a, b]) room.message(c, { t: 'input', area: s.area.index, turn: s.turn, actions: [{ type: 'wait' }], intent: 'decide' });
      sch.advanceBy(10);
    }
    room.message(a, { t: 'chat', text: 'hello there' });
    expect(room.n).toBeGreaterThan(10);
    expect(statSync(worldPath).mtimeMs).toBe(worldMtime);
    const liveHash = hashState(room.state!);
    const liveN = room.n;

    // a "kill -9": a second manager on the same directory, with a torn last line
    appendFileSync(join(dir, 'K7QX.log'), '{"e":{"k":"tu');
    const sch2 = new ManualScheduler(sch.now() + 5000);
    const m2 = manager(sch2);
    const rep = m2.load();
    expect(rep).toMatchObject({ loaded: ['K7QX'], closed: [], broken: [] });
    const again = m2.get('K7QX')!;
    expect(again.n).toBe(liveN);
    expect(hashState(again.state!)).toBe(liveHash);
    expect(again.chat.map((c) => c.text)).toEqual(['hello there']);
    expect(again.seatList().map((s) => [s.seat, s.pid, s.connected])).toEqual([
      ['s1', 'p1', false],
      ['s2', 'p2', false],
    ]);
    // the clients reconnect with their tokens
    const a2 = new FakeConn();
    expect(m2.hello(a2, hello(created.token, 'Ann', { run: 1, lastN: liveN }))).toBe(again);
    const w = a2.last('welcome')!;
    expect(w.entries?.length ?? 0).toBeGreaterThan(0); // the away entry for Bo
    expect(w.snapshot).toBeUndefined();

    // a crash between the room file rewrite and the truncate: the stale lines are skipped
    again.snapshot();
    const n = again.n;
    writeFileSync(join(dir, 'K7QX.log'), logAfterStart.join('\n') + '\n');
    const m3 = manager(new ManualScheduler(sch2.now() + 10));
    m3.load();
    expect(m3.get('K7QX')!.n).toBe(n);
  });

  it('moves an unreadable room to rooms/broken/ and closes rooms of another engine version with a tombstone', () => {
    const sch = new ManualScheduler();
    const m = manager(sch);
    const r1 = m.create({ demo: 'fixture-western' });
    const r2 = m.create({ demo: 'fixture-western' });
    expect(r1.ok && r2.ok).toBe(true);
    writeFileSync(join(dir, 'M2RP.json'), '{not json');
    writeFileSync(join(dir, 'T9WV.json.tmp'), 'x');

    const log: string[] = [];
    const m2 = manager(new ManualScheduler(), 'v2', log);
    const rep = m2.load();
    expect(rep.broken).toEqual(['M2RP']);
    expect(rep.closed).toEqual(['K7QX']);
    expect(rep.tmpRemoved).toBe(1);
    expect(existsSync(join(dir, 'broken', 'M2RP.json'))).toBe(true);
    expect(existsSync(join(dir, 'K7QX.json'))).toBe(false);
    expect(existsSync(join(dir, 'K7QX.world.json'))).toBe(false);
    expect(m2.list()).toEqual([]);
    expect(m2.tombstone('K7QX')?.reason).toBe('server_updated');
    // a token for the closed room: room_closed / server_updated (an old page would get outdated first)
    const c = new FakeConn();
    expect(m2.hello(c, { ...hello('A'.repeat(22), 'Ann'), engine: 'v2' })).toBeNull();
    expect(c.last('refused')).toMatchObject({ code: 'room_closed', reason: 'server_updated' });
    expect(c.closedWith).toBe(4004);
    const old = new FakeConn();
    m2.hello(old, hello(undefined, 'Old'));
    expect(old.last('refused')).toMatchObject({ code: 'outdated', reload: true });
    expect(old.closedWith).toBe(4001);
    expect(log.some((l) => l.includes('K7QX closed'))).toBe(true);
  });
});
