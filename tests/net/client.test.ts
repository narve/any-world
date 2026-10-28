/**
 * MP2 C4: RoomClient (src/net/client.ts) with a fake socket: hello on open, the welcome snapshot,
 * entries applied in order (duplicates skipped) with hash reports every LIMITS.hashEvery and
 * `applied` after an area change, the worldId check, a gap that reconnects for a fresh snapshot,
 * reconnecting after a drop or `bye` with token, run and lastN, and no reconnect after `refused`,
 * `closed` or a replaced socket (with the notice key for the MP3 toast).
 * MP3 D1: per-entry steps with the catch-up flag, stopReason in the stopped status, a late join
 * from a playing welcome, the room / typing / clock state, and the lobby messages.
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

  it('emits per-entry steps (before, after, events, outcomes); a welcome batch is a catch-up', () => {
    const t = setup();
    const start = createGame(world, { seed: 3, players: [{ name: 'Ann' }] });
    const { es, states } = waits(start, 0, 5);
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(start));
    t.last().deliver({ t: 'entries', run: 1, es: es.slice(0, 2) });
    const live = t.events.filter((e): e is Extract<RoomEvent, { t: 'entries' }> => e.t === 'entries');
    expect(live).toHaveLength(1);
    expect(live[0].catchUp).toBe(false);
    expect(live[0].steps.map((x) => x.entry.n)).toEqual([0, 1]);
    expect(hashState(live[0].steps[0].before)).toBe(hashState(start));
    expect(hashState(live[0].steps[0].after)).toBe(hashState(states[0]));
    expect(live[0].steps[1].before).toBe(live[0].steps[0].after);
    expect(live[0].steps[1].after).toBe(t.c.state);
    expect(live[0].steps.flatMap((x) => x.outcomes)).toEqual(live[0].outcomes);
    expect(live[0].steps[0].outcomes[0]).toMatchObject({ playerId: 'p1', ok: true });
    // a reconnect catches up from the welcome's entries
    t.c.drop();
    t.timers.shift()!();
    t.last().open();
    t.last().deliver(welcome(start, { snapshot: undefined, world: undefined, entries: es.slice(2) }));
    const all = t.events.filter((e): e is Extract<RoomEvent, { t: 'entries' }> => e.t === 'entries');
    expect(all).toHaveLength(2);
    expect(all[1].catchUp).toBe(true);
    expect(all[1].steps.map((x) => x.entry.n)).toEqual([2, 3, 4]);
    expect(hashState(t.c.state!)).toBe(hashState(states[4]));
  });

  it('records why it stopped: 4007 (another tab), a refusal’s close code, none after leave()', () => {
    const a = setup(TOKEN);
    a.c.connect();
    a.last().open();
    a.last().deliver(welcome(null));
    a.last().serverClose(4007);
    expect(a.c.stopReason).toBe(4007);
    expect(a.events.at(-1)).toEqual({ t: 'status', status: 'stopped', stopReason: 4007 });

    const b = setup();
    b.c.connect();
    b.last().open();
    b.last().deliver({ t: 'refused', code: 'room_full', message: 'full' });
    expect(b.c.stopReason).toBe(4003);
    expect(b.events.find((e) => e.t === 'status' && e.status === 'stopped')).toMatchObject({ stopReason: 4003 });

    const c = setup(TOKEN);
    c.c.connect();
    c.last().open();
    c.last().deliver(welcome(null));
    c.last().serverClose(1008);
    expect(c.c.stopReason).toBe(1008);
    // connecting again forgets the reason
    c.c.connect();
    expect(c.c.stopReason).toBeUndefined();

    const d = setup(TOKEN);
    d.c.connect();
    d.last().open();
    d.last().deliver(welcome(null));
    d.c.leave();
    expect(d.last().sent.at(-1)).toEqual({ t: 'leave' });
    expect(d.c.stopReason).toBeUndefined();
    expect(d.events.at(-1)).toEqual({ t: 'status', status: 'stopped' });
  });

  it('a late join: a playing welcome gives the replica, the pid and the room at once', () => {
    const t = setup();
    const start = createGame(world, { seed: 3, players: [{ name: 'Ann' }, { name: 'Bea' }, { name: 'Kari' }] });
    const order: string[] = [];
    t.c.on((e) => order.push(e.t === 'state' ? `state:${e.reason}` : e.t));
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(start, { you: { seat: 's3', pid: 'p3', token: TOKEN, host: false }, snapshot: { n: 17, state: serialize(start) } }));
    expect(order).toEqual(['status', 'state:welcome', 'welcome']);
    expect(t.c).toMatchObject({ pid: 'p3', seat: 's3', host: false, phase: 'playing', n: 17 });
    expect(t.c.state!.party).toContain('p3');
    expect(t.c.room).toMatchObject({ code: 'K7QX', phase: 'playing' });
  });

  it('keeps the room, options, typing seats and the clock; sends the lobby messages', () => {
    const t = setup();
    t.c.connect();
    t.last().open();
    t.last().deliver(welcome(null));
    const info = { ...welcome(null).room, world: { ...welcome(null).room.world, title: 'Teen' } };
    t.last().deliver({ t: 'room', room: info, options: { maxPlayers: 4, deadlineMs: 3000, difficulty: 'hard' } });
    expect(t.c.room!.world.title).toBe('Teen');
    expect(t.c.options).toEqual({ maxPlayers: 4, deadlineMs: 3000, difficulty: 'hard' });
    t.last().deliver({ t: 'typing', seat: 's2', on: true });
    t.last().deliver({ t: 'typing', seat: 's3', on: true });
    t.last().deliver({ t: 'typing', seat: 's2', on: false });
    expect([...t.c.typingSeats]).toEqual(['s3']);
    t.last().deliver({ t: 'clock', n: 3, acted: ['p1'], waiting: ['p2'], deadlineInMs: 900 });
    expect(t.c.clock).toMatchObject({ acted: ['p1'], waiting: ['p2'] });
    expect(t.events.filter((e) => e.t === 'message').map((e) => (e as { msg: ServerMsg }).msg.t)).toEqual(['room', 'typing', 'typing', 'typing', 'clock']);
    t.c.ready(true);
    t.c.profile('Kari', PLAYER_COLOURS[4]);
    t.c.pickWorld('fixture-teen');
    t.c.setOptions({ difficulty: 'gentle' });
    t.c.ping('follow', { x: 2, y: 3 });
    expect(t.last().sent.slice(-5)).toEqual([
      { t: 'ready', on: true },
      { t: 'profile', name: 'Kari', colour: PLAYER_COLOURS[4] },
      { t: 'world', demo: 'fixture-teen' },
      { t: 'options', difficulty: 'gentle' },
      { t: 'ping', kind: 'follow', x: 2, y: 3 },
    ]);
    // a welcome (a reconnect) forgets who was typing
    t.last().deliver(welcome(null));
    expect(t.c.typingSeats.size).toBe(0);
  });
});
