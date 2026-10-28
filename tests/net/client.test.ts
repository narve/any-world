/**
 * MP2 C4: RoomClient (src/net/client.ts) with a fake socket: hello on open, the welcome snapshot,
 * entries applied in order (duplicates skipped) with hash reports every LIMITS.hashEvery and
 * `applied` after an area change, the worldId check, a gap that reconnects for a fresh snapshot,
 * reconnecting after a drop or `bye` with token, run and lastN, and no reconnect after `refused`,
 * `closed` or a replaced socket (with the notice key for the MP3 toast).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createGame, hashState, serialize, stepTurn } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { parseWorld, type WorldSpec } from '../../src/schema';
import { RoomClient, type RoomEvent, type RoomSocket } from '../../src/net/client';
import { PLAYER_COLOURS, type ClientMsg, type LogEntry, type ServerMsg, type Welcome } from '../../src/net/protocol';
import { worldIdOf } from '../../src/engine';

const raw = JSON.parse(readFileSync('content/worlds/fixture-western.json', 'utf8')) as unknown;
const world = (() => {
  const r = parseWorld(raw, { strictKeys: true });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.world;
})();
const WORLD_ID = worldIdOf(world);

class FakeSocket implements RoomSocket {
  readyState = 0;
  sent: ClientMsg[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string): void {
    this.sent.push(JSON.parse(d) as ClientMsg);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(m: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(token?: string) {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const events: RoomEvent[] = [];
  const c = new RoomClient({
    url: 'ws://x/api/ws',
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    engine: 'v1',
    room: 'K7QX',
    name: 'Ann',
    colour: PLAYER_COLOURS[0],
    ...(token ? { token } : {}),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  c.on((e) => events.push(e));
  return { c, sockets, timers, events, last: () => sockets.at(-1)! };
}

const TOKEN = 'T'.repeat(22);

function welcome(state: GameState | null, extra: Partial<Welcome> = {}): Welcome {
  return {
    t: 'welcome',
    room: { code: 'K7QX', world: { id: WORLD_ID, title: world.meta.title, genre: world.meta.genre, language: world.meta.language }, players: 1, maxPlayers: 8, phase: state ? 'playing' : 'lobby', joinable: true },
    you: { seat: 's1', pid: state ? 'p1' : null, token: TOKEN, host: true },
    roster: [],
    phase: state ? 'playing' : 'lobby',
    run: state ? 1 : 0,
    options: { maxPlayers: 8, deadlineMs: 2000, difficulty: 'normal' },
    world: raw,
    worldId: WORLD_ID,
    chat: [],
    ...(state ? { snapshot: { n: 0, state: serialize(state) } } : {}),
    ...extra,
  };
}

/** n wait turns from `start`, as entries, with the states after each */
function waits(start: GameState, from: number, count: number): { es: LogEntry[]; states: GameState[] } {
  const es: LogEntry[] = [];
  const states: GameState[] = [];
  let s = start;
  for (let i = 0; i < count; i++) {
    const inputs = [{ playerId: 'p1', actions: [{ type: 'wait' as const }] }];
    s = stepTurn(s, inputs, { world: world as WorldSpec, advance: true }).state;
    es.push({ k: 'turn', inputs, advance: true, n: from + i, run: 1 });
    states.push(s);
  }
  return { es, states };
}

describe('RoomClient', () => {
  it('hello on open, the welcome snapshot, entries in order with hash reports', () => {
    const t = setup();
    t.c.connect();
    t.last().open();
    expect(t.last().sent[0]).toMatchObject({ t: 'hello', v: 1, engine: 'v1', room: 'K7QX', name: 'Ann' });
    expect(t.last().sent[0]).not.toHaveProperty('token');
    const start = createGame(world, { seed: 3, players: [{ name: 'Ann' }] });
    t.last().deliver(welcome(start));
    expect(t.c.status).toBe('joined');
    expect(t.c.token).toBe(TOKEN);
    expect(t.c.pid).toBe('p1');
    expect(hashState(t.c.state!)).toBe(hashState(start));
    const { es, states } = waits(start, 0, 12);
    t.last().deliver({ t: 'entries', run: 1, es: es.slice(0, 5) });
    // a duplicate is skipped
    t.last().deliver({ t: 'entries', run: 1, es: es.slice(4, 12) });
    // another run's entries are dropped
    t.last().deliver({ t: 'entries', run: 7, es: es.slice(0, 1) });
    expect(t.c.n).toBe(12);
    expect(hashState(t.c.state!)).toBe(hashState(states[11]));
    const hashes = t.last().sent.filter((m) => m.t === 'hash');
    expect(hashes).toEqual([{ t: 'hash', n: 10, h: hashState(states[9]) }]);
    // an input carries the area and turn it was decided on
    expect(t.c.input([{ type: 'wait' }])).toBe(true);
    expect(t.last().sent.at(-1)).toEqual({ t: 'input', area: t.c.state!.area.index, turn: t.c.state!.turn, actions: [{ type: 'wait' }], intent: 'decide' });
  });

  it('refuses to play a world whose id does not match', () => {
    const t = setup();
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(null, { worldId: 'some-other-world-123' }));
    expect(t.events.some((e) => e.t === 'fault' && e.reason === 'world_mismatch')).toBe(true);
    expect(t.c.status).toBe('stopped');
    expect(t.timers).toHaveLength(0);
  });

  it('a drop or bye reconnects with token, run and lastN; welcome entries catch up', () => {
    const t = setup();
    const start = createGame(world, { seed: 3, players: [{ name: 'Ann' }] });
    const { es, states } = waits(start, 0, 6);
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(start));
    t.last().deliver({ t: 'entries', run: 1, es: es.slice(0, 3) });
    t.last().deliver({ t: 'bye', reason: 'restart' });
    t.last().serverClose(1012);
    expect(t.c.status).toBe('reconnecting');
    t.timers.shift()!();
    t.last().open();
    expect(t.last().sent[0]).toMatchObject({ t: 'hello', token: TOKEN, run: 1, lastN: 3 });
    t.last().deliver(welcome(start, { snapshot: undefined, world: undefined, entries: es.slice(3) }));
    expect(t.c.reconnects).toBe(1);
    expect(t.c.n).toBe(6);
    expect(hashState(t.c.state!)).toBe(hashState(states[5]));
  });

  it('a gap reconnects without lastN for a fresh snapshot', () => {
    const t = setup();
    const start = createGame(world, { seed: 3, players: [{ name: 'Ann' }] });
    const { es } = waits(start, 0, 4);
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(start));
    t.last().deliver({ t: 'entries', run: 1, es: es.slice(2) });
    expect(t.events.some((e) => e.t === 'fault' && e.reason === 'gap')).toBe(true);
    expect(t.c.n).toBe(0);
    t.timers.shift()!();
    t.last().open();
    expect(t.last().sent[0]).toMatchObject({ t: 'hello', token: TOKEN, run: 1 });
    expect(t.last().sent[0]).not.toHaveProperty('lastN');
  });

  it('refused, closed and a replaced socket end the client with a notice, without reconnecting', () => {
    const a = setup();
    a.c.connect();
    a.last().open();
    a.last().deliver({ t: 'refused', code: 'outdated', message: 'old', reload: true });
    a.last().serverClose(4001);
    expect(a.events.find((e) => e.t === 'notice')).toMatchObject({ notice: { key: 'net.outdated', reload: true } });
    expect(a.c.status).toBe('stopped');
    expect(a.timers).toHaveLength(0);

    const b = setup(TOKEN);
    b.c.connect();
    b.last().open();
    b.last().deliver(welcome(null));
    b.last().deliver({ t: 'closed', reason: 'server_updated', message: 'updated' });
    expect(b.events.find((e) => e.t === 'notice')).toMatchObject({ notice: { key: 'net.serverUpdated', reload: false } });
    expect(b.timers).toHaveLength(0);

    const c = setup(TOKEN);
    c.c.connect();
    c.last().open();
    c.last().deliver(welcome(null));
    c.last().serverClose(4007);
    expect(c.c.status).toBe('stopped');
    expect(c.timers).toHaveLength(0);
  });

  it('joined() rejects with the notice key', async () => {
    const t = setup();
    t.c.connect();
    const p = t.c.joined();
    t.last().open();
    t.last().deliver({ t: 'refused', code: 'room_closed', message: 'closed', reason: 'server_updated' });
    await expect(p).rejects.toThrow('net.serverUpdated');
  });
});
