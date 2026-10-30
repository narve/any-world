/**
 * MP2 C3: one room (server/rooms/room.ts) with fake connections and the manual scheduler: seats
 * (unique names and colours, room_full), lobby seat removal, host hand-over, the replace race,
 * phases and play again, the turn clock in the room, stale inputs, no-op entries, typing and chat
 * rules, the GM intro entry, late join near the host, hashes and the desync snapshot, an area change
 * (countdown at the countdown cadence, pending cleared, area hold), and the 2-minute rule with its
 * guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashState } from '../../src/engine';
import type { GameState, PlayerAction, PlayerId } from '../../src/engine/types';
import { PLAYER_COLOURS, type LogEntry, type ServerMsg } from '../../src/net/protocol';
import { applyEntry } from '../../src/net/log';
import { deserialize, worldIdOf } from '../../src/engine';
import { RoomManager } from '../../server/rooms/manager';
import { DESYNC_SNAPSHOT_MS, EXIT_COUNTDOWN_TURNS, ILLEGAL_LOG_PER_MIN, LOG_COMPACT_LINES, type Conn, type Room } from '../../server/rooms/room';
import { BUSY_MAX_TURNS } from '../../src/engine/ai';
import { registry } from '../../src/engine/registry';
import { ConnBuckets } from '../../server/rooms/limits';
import { LIMITS } from '../../src/net/protocol';
import { DEFAULT_TIMING, ManualScheduler, type RoomTiming } from '../../server/rooms/timing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anyworld-room-'));
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
  of<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
  /** every entry this connection was sent (welcome entries and broadcasts) */
  entries(): LogEntry[] {
    return this.msgs.flatMap((m) => (m.t === 'entries' ? m.es : m.t === 'welcome' ? (m.entries ?? []) : []));
  }
}

interface Setup {
  sch: ManualScheduler;
  m: RoomManager;
  room: Room;
  conns: FakeConn[];
  tokens: string[];
  log: string[];
}

/** a room with `n` connected players (the first is the host); started unless `lobby` */
function setup(n: number, opts: { lobby?: boolean; maxPlayers?: number; timing?: Partial<RoomTiming> } = {}): Setup {
  const sch = new ManualScheduler();
  const log: string[] = [];
  let seed = 7;
  const m = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: (l) => log.push(l), seed: () => ++seed, ...(opts.timing ? { timing: opts.timing } : {}) });
  const created = m.create({ demo: 'fixture-western', options: opts.maxPlayers ? { maxPlayers: opts.maxPlayers } : {} });
  if (!created.ok) throw new Error(created.error);
  const conns: FakeConn[] = [];
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = new FakeConn();
    const room = m.hello(c, hello(created.code, i === 0 ? created.token : undefined, `P${i + 1}`, PLAYER_COLOURS[i]));
    if (!room) throw new Error(`join ${i} refused: ${JSON.stringify(c.msgs.at(-1))}`);
    conns.push(c);
    tokens.push(c.last('welcome')!.you.token);
  }
  const room = created.room;
  if (!opts.lobby) room.message(conns[0], { t: 'start' });
  return { sch, m, room, conns, tokens, log };
}

function hello(room: string, token: string | undefined, name: string, colour: string = PLAYER_COLOURS[0], extra: Record<string, unknown> = {}) {
  return { t: 'hello' as const, v: 1 as const, engine: 'v1', room, name, colour: colour as (typeof PLAYER_COLOURS)[number], ...(token ? { token } : {}), ...extra };
}

function act(room: Room, c: FakeConn, action: PlayerAction, intent: 'decide' | 'travel' | 'wait' = 'decide') {
  const s = room.state!;
  room.message(c, { t: 'input', area: s.area.index, turn: s.turn, actions: [action], intent });
}

function turns(room: Room): Extract<LogEntry, { k: 'turn' }>[] {
  return room.recentEntries().filter((e): e is Extract<LogEntry, { k: 'turn' }> => e.k === 'turn');
}

function actorOf(state: GameState, pid: PlayerId) {
  return state.area.actors.find((a) => a.id === state.players[pid].actorId)!;
}

describe('seats and roster', () => {
  it('makes names and colours unique, and refuses a full room', () => {
    const { m, room, conns } = setup(1, { lobby: true, maxPlayers: 3 });
    const b = new FakeConn();
    m.hello(b, hello(room.code, undefined, 'p1', PLAYER_COLOURS[0]));
    const c = new FakeConn();
    m.hello(c, hello(room.code, undefined, 'P1', PLAYER_COLOURS[1]));
    expect(room.seatList().map((s) => [s.seat, s.name, s.colour])).toEqual([
      ['s1', 'P1', PLAYER_COLOURS[0]],
      ['s2', 'p1 2', PLAYER_COLOURS[1]],
      ['s3', 'P1 3', PLAYER_COLOURS[2]],
    ]);
    const roster = conns[0].last('roster')!.seats;
    expect(roster.map((r) => r.name)).toEqual(['P1', 'p1 2', 'P1 3']);
    expect(roster[0].host).toBe(true);
    const d = new FakeConn();
    expect(m.hello(d, hello(room.code, undefined, 'Dee'))).toBeNull();
    expect(d.last('refused')?.code).toBe('room_full');
    expect(d.closedWith).toBe(4003);
    const e = new FakeConn();
    m.hello(e, hello(room.code, 'B'.repeat(22), 'Eve'));
    expect(e.last('refused')?.code).toBe('bad_token');
    const f = new FakeConn();
    m.hello(f, hello('ZZZZ', undefined, 'Fay'));
    expect(f.last('refused')?.code).toBe('no_room');
  });

  it('removes a lobby seat that is off for 2 minutes, and hands the host over to the longest-connected seat', () => {
    const { sch, room, conns } = setup(3, { lobby: true });
    // the host leaves: s2 (connected before s3) becomes host
    room.disconnect(conns[0]);
    expect(room.host).toBe('s2');
    expect(conns[1].last('roster')!.seats.find((r) => r.seat === 's2')!.host).toBe(true);
    sch.advanceBy(DEFAULT_TIMING.awayMs - 1);
    expect(room.seatList()).toHaveLength(3);
    sch.advanceBy(2);
    expect(room.seatList().map((s) => s.seat)).toEqual(['s2', 's3']);
    expect(conns[2].last('roster')!.seats.map((r) => r.seat)).toEqual(['s2', 's3']);
  });

  it('a returning ex-host does not take the host back; a second socket replaces the first and its late close does nothing', () => {
    const { m, room, conns, tokens } = setup(2, { lobby: true });
    room.disconnect(conns[0]);
    const back = new FakeConn();
    m.hello(back, hello(room.code, tokens[0], 'P1'));
    expect(room.host).toBe('s2');
    expect(back.last('welcome')!.you).toMatchObject({ seat: 's1', host: false });
    // a new tab for s2
    const tab = new FakeConn();
    m.hello(tab, hello(room.code, tokens[1], 'P2', PLAYER_COLOURS[1]));
    expect(conns[1].closedWith).toBe(4007);
    room.disconnect(conns[1]); // the old socket's late close
    expect(room.seatList().find((s) => s.seat === 's2')!.connected).toBe(true);
    expect(room.host).toBe('s2');
  });

  it('only the host starts; the run gets one character per seat in seat order', () => {
    const { room, conns } = setup(2, { lobby: true });
    room.message(conns[1], { t: 'start' });
    expect(conns[1].last('error')?.code).toBe('not_host');
    room.message(conns[0], { t: 'start' });
    expect(room.phase).toBe('playing');
    expect(room.state!.party).toEqual(['p1', 'p2']);
    expect(room.state!.partyRules.exitCountdownTurns).toBe(EXIT_COUNTDOWN_TURNS);
    expect(conns[1].last('run')).toMatchObject({ run: 1, snapshot: { n: 0 } });
    room.message(conns[0], { t: 'start' });
    expect(conns[0].last('error')?.code).toBe('bad_phase');
  });
});

describe('turns', () => {
  it('asks the canned GM for the intro and resolves a turn as soon as every active player acted', () => {
    const { sch, room, conns } = setup(2);
    const gm = room.recentEntries().find((e) => e.k === 'gm');
    expect(gm).toMatchObject({ k: 'gm', hook: 'intro' });
    const n0 = room.n;
    act(room, conns[0], { type: 'wait' });
    expect(room.n).toBe(n0);
    sch.advanceBy(DEFAULT_TIMING.clockThrottleMs); // (clock messages are throttled)
    expect(conns[1].last('clock')).toMatchObject({ acted: ['p1'], waiting: ['p2'] });
    act(room, conns[1], { type: 'wait' });
    expect(turns(room).at(-1)).toMatchObject({ k: 'turn', advance: false, inputs: [{ playerId: 'p1' }, { playerId: 'p2' }] });
    // every client was sent the same entries, and they replay to the server's state
    const w = conns[1].of('run')[0];
    let s = deserialize(room.world.world, w.snapshot.state);
    for (const e of conns[1].entries()) s = applyEntry(room.world.world, s, e).state;
    expect(hashState(s)).toBe(hashState(room.state!));
  });

  it('resolves at the deadline with advance when someone has not acted; idle players do not hold a turn', () => {
    const { sch, room, conns } = setup(2, {});
    act(room, conns[0], { type: 'wait' });
    const n0 = room.n;
    sch.advanceBy(1999);
    expect(room.n).toBe(n0);
    sch.advanceBy(1);
    expect(turns(room).at(-1)).toMatchObject({ advance: true, inputs: [{ playerId: 'p1' }] });
    // p2 goes idle after 10 s without input: then p1's input alone resolves at once
    sch.advanceBy(DEFAULT_TIMING.idleActiveMs);
    room.message(conns[0], { t: 'presence', state: 'playing' });
    const n1 = room.n;
    act(room, conns[0], { type: 'wait' });
    expect(room.n).toBe(n1 + 1);
    expect(conns[0].last('roster')!.seats.find((r) => r.seat === 's2')!.presence).toBe('idle');
  });

  it('takes the test deadline from the timing, and logs a player whose actions keep coming back illegal', () => {
    const { sch, room, conns, log } = setup(2, { timing: { deadlineMs: 300 } });
    expect(room.options.deadlineMs).toBe(2000);
    expect(room.clockView().deadlineMs).toBe(300);
    act(room, conns[0], { type: 'wait' });
    const n0 = room.n;
    sch.advanceBy(300);
    expect(room.n).toBe(n0 + 1);
    // an empty slot is 'illegal' (or 'stale' when p2 moved first); p2's wait makes each turn a real entry
    for (let i = 0; i < 3 * ILLEGAL_LOG_PER_MIN; i++) {
      act(room, conns[0], { type: 'unequip', slot: 27 });
      act(room, conns[1], { type: 'wait' });
    }
    expect(turns(room).at(-1)!.inputs[0]).toMatchObject({ playerId: 'p1', actions: [{ type: 'unequip', slot: 27 }] });
    expect(log.filter((l) => l.includes('illegal actions in a minute'))).toHaveLength(1);
  });

  it('travel intents resolve at the travel cadence; nothing pending means the world does not move', () => {
    const { sch, room, conns } = setup(2);
    sch.advanceBy(5000);
    const n0 = room.n;
    sch.advanceBy(60_000);
    expect(room.n).toBe(n0);
    for (const c of conns) room.message(c, { t: 'presence', state: 'playing' });
    act(room, conns[0], { type: 'wait' }, 'travel');
    act(room, conns[1], { type: 'wait' }, 'wait');
    // lastResolveAt was long ago: the cadence is already due
    expect(room.n).toBe(n0 + 1);
    act(room, conns[0], { type: 'wait' }, 'travel');
    act(room, conns[1], { type: 'wait' }, 'travel');
    expect(room.n).toBe(n0 + 1);
    sch.advanceBy(DEFAULT_TIMING.travelMs);
    expect(room.n).toBe(n0 + 2);
  });

  it('MP5: calm (no hostile in view), a decide input waits only the grace for a thinking teammate, travel only the cadence', () => {
    const { sch, room, conns } = setup(2);
    for (const a of room.state!.area.actors) if (a.faction === 'hostile') a.hp = 0;
    expect(room.clockView().calm).toBe(true);
    act(room, conns[0], { type: 'wait' });
    const n0 = room.n;
    sch.advanceBy(DEFAULT_TIMING.calmGraceMs - 1);
    expect(room.n).toBe(n0);
    sch.advanceBy(1);
    expect(room.n).toBe(n0 + 1);
    expect(turns(room).at(-1)).toMatchObject({ advance: true, inputs: [{ playerId: 'p1' }] });
    act(room, conns[0], { type: 'wait' }, 'travel');
    sch.advanceBy(DEFAULT_TIMING.travelMs);
    expect(room.n).toBe(n0 + 2);
  });

  it('MP5: a down player gets up while the teammates do nothing (a turn a second while calm)', () => {
    const { sch, room, conns } = setup(3);
    const s = room.state!;
    for (const a of s.area.actors) if (a.faction === 'hostile') a.hp = 0;
    // p3 away from the others, so only the self-revive counts
    const far = s.area.actors.find((a) => a.id === s.players.p3.actorId)!;
    far.hp = 0;
    s.players.p3.down = { since: s.turn, helpedTurns: 0 };
    const n0 = room.n;
    room.message(conns[0], { t: 'presence', state: 'playing' });
    expect(room.clockView().downWaiting).toBe(true);
    sch.advanceBy(30_000);
    expect(room.n).toBeGreaterThan(n0);
    expect(room.state!.players.p3.down).toBeFalsy();
    // standing up again: nothing pending, the world stands still once more
    const n1 = room.n;
    sch.advanceBy(10_000);
    expect(room.n).toBe(n1);
    void conns;
  });

  it('drops stale inputs, appends free actions at once, and never appends a no-op (the actor gets a refusal)', () => {
    const { room, conns } = setup(2);
    const s = room.state!;
    const n0 = room.n;
    room.message(conns[0], { t: 'input', area: s.area.index + 1, turn: s.turn, actions: [{ type: 'wait' }], intent: 'decide' });
    expect(conns[0].last('error')?.code).toBe('stale');
    room.message(conns[0], { t: 'input', area: s.area.index, turn: s.turn + 1, actions: [{ type: 'wait' }], intent: 'decide' });
    expect(conns[0].of('error')).toHaveLength(2);
    // a refused free action: nothing appended, a refusal to the actor only
    room.message(conns[0], { t: 'input', area: s.area.index, turn: s.turn, actions: [{ type: 'talk', targetId: 'nobody' }], intent: 'decide' });
    expect(room.n).toBe(n0);
    expect(conns[0].last('refusal')!.reasons[0]).toMatchObject({ action: { type: 'talk' }, reason: 'illegal' });
    expect(conns[1].of('refusal')).toHaveLength(0);
    room.message(conns[0], { t: 'input', area: s.area.index, turn: s.turn, actions: [{ type: 'toggle_sneak' }], intent: 'decide' });
    expect(conns[0].last('refusal')!.reasons[0]).toMatchObject({ reason: 'illegal', detail: 'sneaking is not possible here' });
    expect(room.n).toBe(n0);
    // busy alone is its own entry, without advance; twice, the second is a no-op
    room.message(conns[1], { t: 'input', area: s.area.index, turn: s.turn, actions: [], busy: true, intent: 'decide' });
    expect(turns(room).at(-1)).toMatchObject({ advance: false, inputs: [{ playerId: 'p2', busy: true }] });
    room.message(conns[1], { t: 'input', area: s.area.index, turn: s.turn, actions: [], busy: true, intent: 'decide' });
    expect(room.n).toBe(n0 + 1);
    // older than LIMITS.staleTurns
    for (let i = 0; i < 5; i++) {
      act(room, conns[0], { type: 'wait' });
      act(room, conns[1], { type: 'wait' });
    }
    room.message(conns[0], { t: 'input', area: s.area.index, turn: s.turn, actions: [{ type: 'wait' }], intent: 'decide' });
    expect(conns[0].last('error')?.code).toBe('stale');
  });

  it('typing sets busy (and again after the typist’s own action), a chat line or 8 s ends it', () => {
    const { sch, room, conns } = setup(2);
    room.message(conns[1], { t: 'typing', on: true });
    expect(room.state!.players.p2.busySince).not.toBeNull();
    expect(conns[0].last('typing')).toEqual({ t: 'typing', seat: 's2', on: true });
    // a typing player is inactive: p1 alone resolves the turn
    const n0 = room.n;
    act(room, conns[0], { type: 'wait' });
    expect(room.n).toBe(n0 + 1);
    // the typist acts: its action clears busy, the room sets it again
    act(room, conns[1], { type: 'wait' });
    act(room, conns[0], { type: 'wait' });
    const last = room.recentEntries().at(-1)!;
    expect(last).toMatchObject({ k: 'turn', inputs: [{ playerId: 'p2', busy: true }] });
    expect(room.state!.players.p2.busySince).not.toBeUndefined();
    sch.advanceBy(DEFAULT_TIMING.typingExpiryMs);
    expect(room.state!.players.p2.busySince ?? null).toBeNull();
    expect(conns[0].last('typing')).toEqual({ t: 'typing', seat: 's2', on: false });
  });

  it('MP5: a typing toggle sends no roster (the typing frame carries it); a newcomer gets the typing frames of those typing', () => {
    const { room, conns } = setup(2);
    const rosters = conns[0].of('roster').length;
    room.message(conns[1], { t: 'typing', on: true });
    room.message(conns[1], { t: 'typing', on: false });
    room.message(conns[1], { t: 'typing', on: true });
    expect(conns[0].of('roster').length).toBe(rosters);
    expect(room.roster().map((r) => r.presence)).toEqual(['active', 'active']);
    const late = new FakeConn();
    setupJoin(room, late, 'Cy');
    expect(late.of('typing')).toEqual([{ t: 'typing', seat: 's2', on: true }]);
  });
});

describe('chat', () => {
  it('relays lines to everyone, keeps the last 100, refuses long lines and more than one a second', () => {
    const { sch, room, conns } = setup(2, { lobby: true });
    room.message(conns[0], { t: 'chat', text: '  hi\u0007 there ' });
    expect(conns[1].last('chat')!.line).toMatchObject({ seat: 's1', name: 'P1', text: 'hi there' });
    room.message(conns[0], { t: 'chat', text: 'again' });
    expect(conns[0].last('error')?.code).toBe('chat_rate');
    sch.advanceBy(1000);
    room.message(conns[0], { t: 'chat', text: 'x'.repeat(201) });
    expect(conns[0].last('error')?.code).toBe('chat_long');
    for (let i = 0; i < 120; i++) {
      sch.advanceBy(1000);
      room.message(conns[i % 2], { t: 'chat', text: `line ${i}` });
    }
    expect(room.chat).toHaveLength(100);
    expect(room.chat.at(-1)!.text).toBe('line 119');
    const late = new FakeConn();
    setupJoin(room, late);
    expect(late.last('welcome')!.chat.map((c) => c.text)).toEqual(room.chat.map((c) => c.text));
  });
});

function setupJoin(room: Room, c: FakeConn, name = 'Late') {
  // (rooms are reached through the manager in production; a direct hello is the same after its checks)
  return room.hello(c, hello(room.code, undefined, name, PLAYER_COLOURS[5]));
}

describe('joining, reconnecting, hashes', () => {
  it('a late joiner gets a join entry next to the host, then a snapshot after it', () => {
    const { room, conns } = setup(2);
    const late = new FakeConn();
    expect(setupJoin(room, late)).toBeNull();
    const join = room.recentEntries().find((e) => e.k === 'join')!;
    expect(join).toMatchObject({ k: 'join', seat: 's3', pid: 'p3', near: 'p1' });
    const w = late.last('welcome')!;
    expect(w.you.pid).toBe('p3');
    expect(w.snapshot!.n).toBe(room.n);
    const s = room.state!;
    const a = actorOf(s, 'p3').pos;
    const h = actorOf(s, 'p1').pos;
    expect(Math.max(Math.abs(a.x - h.x), Math.abs(a.y - h.y))).toBeLessThanOrEqual(4);
    expect(conns[0].entries().some((e) => e.k === 'join')).toBe(true);
    expect(late.of('entries')).toHaveLength(0);
  });

  it('a reconnect within 2 minutes: away then back, the welcome carries the missing entries (sent once)', () => {
    const { sch, m, room, conns, tokens } = setup(3);
    room.disconnect(conns[1]);
    expect(room.recentEntries().at(-1)).toMatchObject({ k: 'away', pid: 'p2' });
    expect(room.state!.players.p2.away).toBe(true);
    expect(conns[0].last('roster')!.seats[1]).toMatchObject({ connected: false, presence: 'off' });
    // turns go on without p2
    const lastN = room.n;
    act(room, conns[0], { type: 'wait' });
    act(room, conns[2], { type: 'wait' });
    expect(room.n).toBe(lastN + 1);
    sch.advanceBy(60_000);
    const again = new FakeConn();
    expect(m.hello(again, hello(room.code, tokens[1], 'P2', PLAYER_COLOURS[1], { run: 1, lastN }))).toBe(room);
    const w = again.last('welcome')!;
    expect(w.snapshot).toBeUndefined();
    expect(w.world).toBeUndefined();
    expect(w.you.pid).toBe('p2');
    expect(w.entries!.map((e) => e.k)).toEqual(['turn', 'back']);
    expect(again.of('entries')).toHaveLength(0);
    expect(room.state!.players.p2.away).toBeUndefined();
    // the run differs (or lastN is beyond the server): a snapshot instead
    const third = new FakeConn();
    m.hello(third, hello(room.code, tokens[2], 'P3', PLAYER_COLOURS[2], { run: 1, lastN: room.n + 5 }));
    expect(third.last('welcome')!.snapshot!.n).toBe(room.n);
  });

  it('keeps a hash every 10 entries and sends a snapshot to a client that disagrees', () => {
    const { room, conns, log } = setup(2);
    while (room.n < 21) {
      act(room, conns[0], { type: 'wait' });
      act(room, conns[1], { type: 'wait' });
    }
    expect(room.hashAt(20)).toMatch(/^[0-9a-f]{16}$/);
    room.message(conns[0], { t: 'hash', n: 20, h: room.hashAt(20)! });
    expect(conns[0].of('snapshot')).toHaveLength(0);
    room.message(conns[1], { t: 'hash', n: 20, h: '0123456789abcdef' });
    expect(conns[1].last('snapshot')).toMatchObject({ run: 1, n: room.n });
    expect(log.some((l) => l.includes('desync seat s2 at n=20'))).toBe(true);
  });
});

describe('area change', () => {
  it('a countdown resolves at the countdown cadence, the change clears pending inputs and holds the clock until applied', () => {
    const { sch, room, conns } = setup(2);
    const s = room.state!;
    // put p1 on the exit
    actorOf(s, 'p1').pos = { ...s.area.map.exit };
    act(room, conns[0], { type: 'transition' });
    act(room, conns[1], { type: 'wait' });
    expect(room.state!.area.exitCountdown).toBeTruthy();
    const n0 = room.n;
    sch.advanceBy(DEFAULT_TIMING.countdownTurnMs);
    expect(room.n).toBe(n0 + 1);
    expect(turns(room).at(-1)!.advance).toBe(true);
    let guard = 0;
    while (room.state!.area.index === 0 && guard++ < EXIT_COUNTDOWN_TURNS * 3) {
      // p2 keeps a pending input in the queue (p1 never acts: it resolves on the countdown)
      for (const c of conns) room.message(c, { t: 'presence', state: 'playing' });
      if (room.state!.area.index === 0) act(room, conns[1], { type: 'wait' });
      sch.advanceBy(DEFAULT_TIMING.countdownTurnMs);
    }
    expect(room.state!.area.index).toBe(1);
    expect(room.clockView().pending.size).toBe(0);
    expect(room.clockView().areaHoldUntil).not.toBeNull();
    const n1 = room.n;
    // both act during the hold: nothing resolves until both applied
    act(room, conns[0], { type: 'wait' });
    act(room, conns[1], { type: 'wait' });
    expect(room.n).toBe(n1);
    room.message(conns[0], { t: 'applied', n: n1 });
    expect(room.n).toBe(n1);
    room.message(conns[1], { t: 'applied', n: n1 });
    expect(room.n).toBe(n1 + 1);
  });
});

describe('the 2-minute rule', () => {
  it('leaves the map after 2 minutes away (items on the floor, seat gone) and returns with an empty pack and the old hp', () => {
    const { sch, m, room, conns, tokens } = setup(3);
    const before = room.state!;
    const pos = { ...actorOf(before, 'p2').pos };
    const packed = before.players.p2.slots.filter(Boolean).length;
    expect(packed).toBeGreaterThan(0);
    room.disconnect(conns[1]);
    sch.advanceBy(DEFAULT_TIMING.awayMs - 1);
    expect(room.state!.party).toContain('p2');
    sch.advanceBy(1);
    expect(room.recentEntries().at(-1)).toMatchObject({ k: 'leave', pid: 'p2' });
    const s = room.state!;
    expect(s.party).not.toContain('p2');
    expect(s.area.items.filter((i) => i.pos.x === pos.x && i.pos.y === pos.y).length).toBeGreaterThanOrEqual(packed);
    expect(conns[0].last('roster')!.seats[1].presence).toBe('gone');
    const hp = s.players.p2.left!.actor.hp;
    // reconnect later: a return entry next to the host, empty pack, the hp it left with
    sch.advanceBy(30_000);
    const again = new FakeConn();
    m.hello(again, hello(room.code, tokens[1], 'P2', PLAYER_COLOURS[1]));
    expect(room.recentEntries().at(-1)).toMatchObject({ k: 'return', pid: 'p2', near: 'p1' });
    const r = room.state!;
    expect(r.party).toContain('p2');
    expect(r.players.p2.slots.filter(Boolean)).toHaveLength(0);
    expect(actorOf(r, 'p2').hp).toBe(Math.max(1, hp));
    expect(again.last('welcome')!.you.pid).toBe('p2');
  });

  it('nobody leaves while no seat is connected; the timers of the others start when one comes back', () => {
    const { sch, m, room, conns, tokens } = setup(2);
    room.disconnect(conns[1]);
    room.disconnect(conns[0]);
    expect(sch.pending).toBe(0); // an empty room sleeps
    sch.advanceBy(10 * 60_000);
    expect(room.state!.party).toEqual(['p1', 'p2']);
    const back = new FakeConn();
    m.hello(back, hello(room.code, tokens[0], 'P1'));
    sch.advanceBy(DEFAULT_TIMING.awayMs - 1);
    expect(room.state!.party).toEqual(['p1', 'p2']);
    sch.advanceBy(1);
    expect(room.state!.party).toEqual(['p1']);
  });

  it('nobody leaves while every other party member is down, nor the last member; it leaves once someone stands', () => {
    const { sch, room, conns } = setup(2);
    room.disconnect(conns[1]);
    const s = room.state!;
    s.players.p1.down = { since: s.turn, helpedTurns: 0 };
    sch.advanceBy(DEFAULT_TIMING.awayMs + 10_000);
    expect(room.state!.party).toEqual(['p1', 'p2']);
    delete room.state!.players.p1.down;
    room.message(conns[0], { t: 'presence', state: 'playing' });
    expect(room.state!.party).toEqual(['p1']);
    // the last member: p1 goes off; no leave ever (and the room is not empty: p1 has not sent leave)
    const other = setupJoinPlaying(room);
    room.disconnect(conns[0]);
    sch.advanceBy(DEFAULT_TIMING.awayMs + 1);
    expect(room.state!.party).toContain('p3');
    expect(room.closed).toBe(false);
    void other;
  });

  it('MP5: a reconnect that replaces a still-open socket does not restart the others\' 2-minute timers', () => {
    const { sch, m, room, conns, tokens } = setup(2);
    room.disconnect(conns[1]);
    sch.advanceBy(90_000);
    // p1's phone switches network: a new socket with the same token before the old one is noticed dead
    const again = new FakeConn();
    m.hello(again, hello(room.code, tokens[0], 'P1'));
    expect(conns[0].closedWith).not.toBeNull();
    sch.advanceBy(DEFAULT_TIMING.awayMs - 90_000);
    expect(room.state!.party).toEqual(['p1']);
  });

  it('closes the room when every seat has sent leave or is gone', () => {
    const { sch, room, conns, log } = setup(2);
    room.message(conns[1], { t: 'leave' });
    expect(conns[1].closedWith).toBe(1000);
    sch.advanceBy(DEFAULT_TIMING.awayMs);
    expect(room.state!.party).toEqual(['p1']);
    room.message(conns[0], { t: 'leave' });
    expect(room.closed).toBe(true);
    expect(log.some((l) => l.includes('closed (empty)'))).toBe(true);
  });
});

function setupJoinPlaying(room: Room): FakeConn {
  const c = new FakeConn();
  setupJoin(room, c, 'Third');
  return c;
}

describe('phases', () => {
  it('ends the run and plays again with the seats connected or off for less than 2 minutes', () => {
    const { sch, room, conns } = setup(3);
    room.disconnect(conns[2]);
    sch.advanceBy(DEFAULT_TIMING.awayMs + 1); // s3 leaves the map
    room.disconnect(conns[1]);
    // the run is lost (as if the last entry had ended it)
    const before = room.state!;
    const lost = { ...before, status: 'lost' as const };
    (room as unknown as { state: GameState }).state = lost;
    (room as unknown as { settle: (a: GameState, b: GameState) => void }).settle(before, lost);
    expect(room.phase).toBe('ended');
    act(room, conns[0], { type: 'wait' });
    expect(conns[0].last('error')?.code).toBe('bad_phase');
    sch.advanceBy(1000);
    room.message(conns[0], { t: 'start', demo: 'fixture-teen' });
    expect(room.phase).toBe('playing');
    expect(room.run).toBe(2);
    expect(room.n).toBeGreaterThan(0);
    expect(room.seatList().map((s) => s.seat)).toEqual(['s1', 's2']);
    expect(room.state!.party).toEqual(['p1', 'p2']);
    // s2 is off: its character is away from the start
    expect(room.state!.players.p2.away).toBe(true);
    const run = conns[0].last('run')!;
    expect(run).toMatchObject({ run: 2, snapshot: { n: 0 } });
    expect(run.world).toBeTruthy();
    expect(room.world.source).toEqual({ demo: 'fixture-teen' });
  });
});

describe('manager', () => {
  it('limits the rooms, closes idle rooms after 2 hours with a tombstone, and refuses an unknown demo', () => {
    const sch = new ManualScheduler();
    const log: string[] = [];
    let k = 0;
    const m = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: (l) => log.push(l), maxRooms: 2, code: () => ['AAAA', 'BBBB', 'CCCC'][k++ % 3] });
    expect(m.create({ demo: 'no-such-world' })).toEqual({ ok: false, error: 'no_demo' });
    const a = m.create({ demo: 'fixture-western' });
    sch.advanceBy(10);
    const b = m.create({ demo: 'fixture-western', options: { maxPlayers: 3, deadlineMs: 1000, difficulty: 'hard' } });
    expect(a.ok && b.ok).toBe(true);
    expect(m.create({ demo: 'fixture-western' })).toEqual({ ok: false, error: 'server_full' });
    expect(m.list().map((r) => r.code)).toEqual(['BBBB', 'AAAA']);
    expect(m.list()[0]).toMatchObject({ maxPlayers: 3, players: 1, phase: 'lobby', joinable: true });
    m.start();
    // a connected player keeps chatting in AAAA: only BBBB (connected, silent) goes idle
    const c = new FakeConn();
    m.hello(c, hello('AAAA', a.ok ? a.token : undefined, 'Ann'));
    m.hello(new FakeConn(), hello('BBBB', b.ok ? b.token : undefined, 'Ben'));
    for (let t = 0; t < 130; t++) {
      sch.advanceBy(60_000);
      m.get('AAAA')?.message(c, { t: 'chat', text: `minute ${t}` });
    }
    expect(m.list().map((r) => r.code)).toEqual(['AAAA']);
    expect(m.tombstone('BBBB')?.reason).toBe('idle');
    const late = new FakeConn();
    m.hello(late, hello('BBBB', undefined, 'Bo'));
    expect(late.last('refused')).toMatchObject({ code: 'room_closed', reason: 'idle' });
    // shutdown: a snapshot and bye to every connection
    m.shutdown();
    expect(c.last('bye')).toEqual({ t: 'bye', reason: 'restart' });
  });
});

/** ends the run as if the last entry had lost it */
function endRun(room: Room): void {
  const before = room.state!;
  const lost = { ...before, status: 'lost' as const };
  (room as unknown as { state: GameState }).state = lost;
  (room as unknown as { settle: (a: GameState, b: GameState) => void }).settle(before, lost);
}

/** a demo world as an upload (a copy with another title, so its id differs) */
function upload(m: RoomManager, demo: string, title?: string) {
  const d = m.demos.get(demo)!;
  const world = title ? { ...d.world, meta: { ...d.world.meta, title } } : d.world;
  return { world, worldId: worldIdOf(world), source: { upload: true as const } };
}

describe('review fixes', () => {
  it('a world uploaded in the lobby reaches everyone in the run message', () => {
    const { m, room, conns, tokens } = setup(2, { lobby: true });
    const ship = upload(m, 'fixture-ship');
    expect(room.uploadWorld(tokens[0], ship)).toBe('ok');
    room.message(conns[0], { t: 'start' });
    for (const c of conns) expect(c.last('run')).toMatchObject({ worldId: ship.worldId, world: { meta: { title: ship.world.meta.title } } });
  });

  it('closes a lobby nobody has been connected to for 2 minutes (a creator who never connects), not a running room', () => {
    const sch = new ManualScheduler();
    const m = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: () => {} });
    m.start();
    const a = m.create({ demo: 'fixture-western' });
    const b = m.create({ demo: 'fixture-western' });
    if (!a.ok || !b.ok) throw new Error('create');
    const c = new FakeConn();
    m.hello(c, hello(b.code, b.token, 'Bo'));
    b.room.message(c, { t: 'start' });
    b.room.disconnect(c);
    sch.advanceBy(DEFAULT_TIMING.awayMs + DEFAULT_TIMING.idleSweepMs);
    expect(m.get(a.code)).toBeUndefined();
    expect(m.tombstone(a.code)?.reason).toBe('empty');
    expect(m.get(b.code)).toBe(b.room);
  });

  it('a host options message that changes nothing is not written, and options have their own rate', () => {
    const { m, room, conns } = setup(1, { lobby: true });
    const spy = vi.spyOn(m.store, 'writeRoom');
    room.message(conns[0], { t: 'options', deadlineMs: room.options.deadlineMs });
    expect(spy).not.toHaveBeenCalled();
    room.message(conns[0], { t: 'options', deadlineMs: 1000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const bk = new ConnBuckets(0);
    let ok = 0;
    for (let i = 0; i < 40; i++) if (bk.take('options', 0)) ok++;
    expect(ok).toBe(LIMITS.rates.options.burst);
  });

  it('a store failure during a hello closes that room, it does not throw', () => {
    const { m, room } = setup(1, { lobby: true });
    vi.spyOn(m.store, 'append').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const c = new FakeConn();
    expect(() => m.hello(c, hello(room.code, undefined, 'Bo'))).not.toThrow();
    expect(room.closed).toBe(true);
    expect(c.last('refused')?.code).toBe('room_closed');
  });

  it('chat in the lobby does not grow the log without bound, and a reload keeps the last lines', () => {
    const { sch, m, room, conns } = setup(1, { lobby: true });
    for (let i = 0; i < LOG_COMPACT_LINES * 2 + 50; i++) {
      sch.advanceBy(1000);
      room.message(conns[0], { t: 'chat', text: `line ${i}` });
    }
    const lines = readFileSync(join(dir, `${room.code}.log`), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThan(LOG_COMPACT_LINES);
    m.shutdown();
    const m2 = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: () => {} });
    m2.load();
    const chat = m2.get(room.code)!.chat;
    expect(chat).toHaveLength(LIMITS.chatHistory);
    expect(chat.at(-1)!.text).toBe(`line ${LOG_COMPACT_LINES * 2 + 49}`);
  });

  it('a world staged after a run and then replaced, overridden or left by a closing room leaves the registry', () => {
    const { m, room, conns, tokens } = setup(1);
    endRun(room);
    const base = registry.size;
    const w1 = upload(m, 'fixture-ship', 'Staged one');
    const w2 = upload(m, 'fixture-ship', 'Staged two');
    expect(room.uploadWorld(tokens[0], w1)).toBe('ok');
    expect(room.uploadWorld(tokens[0], w2)).toBe('ok');
    expect(registry.has(w1.worldId)).toBe(false);
    expect(registry.has(w2.worldId)).toBe(true);
    // start with a demo instead: the staged one goes
    room.message(conns[0], { t: 'start', demo: 'fixture-teen' });
    expect(registry.has(w2.worldId)).toBe(false);
    endRun(room);
    const w3 = upload(m, 'fixture-ship', 'Staged three');
    room.uploadWorld(tokens[0], w3);
    room.close('idle');
    expect(registry.has(w3.worldId)).toBe(false);
    expect(registry.size).toBeLessThanOrEqual(base);
  });

  it('a wrong hash gets at most one snapshot per seat every few seconds', () => {
    const { sch, room, conns } = setup(2);
    for (let i = 0; i < 10; i++) room.message(conns[1], { t: 'hash', n: 0, h: '0000000000000000' });
    expect(conns[1].of('snapshot')).toHaveLength(1);
    sch.advanceBy(DESYNC_SNAPSHOT_MS);
    room.message(conns[1], { t: 'hash', n: 0, h: '0000000000000000' });
    expect(conns[1].of('snapshot')).toHaveLength(2);
  });

  it('a late joiner whose join entry was lost (a kill between seat record and entry) gets one character on reconnect', () => {
    const { sch, room } = setup(2);
    const late = new FakeConn();
    setupJoin(room, late);
    const token = late.last('welcome')!.you.token;
    const path = join(dir, `${room.code}.log`);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => l.includes('"k":"join"'));
    expect(at).toBeGreaterThan(0);
    // the seat record with its pid comes before the entry
    expect(JSON.parse(lines[at - 1])).toMatchObject({ seat: { seat: 's3', pid: 'p3' } });
    writeFileSync(path, lines.slice(0, at).map((l) => `${l}\n`).join(''));
    const m2 = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: () => {} });
    m2.load();
    const r2 = m2.get(room.code)!;
    expect(r2.state!.party).toEqual(['p1', 'p2']);
    m2.hello(new FakeConn(), hello(room.code, token, 'Late', PLAYER_COLOURS[5]));
    expect(r2.state!.party).toEqual(['p1', 'p2', 'p3']);
    expect(r2.seatList().find((x) => x.seat === 's3')!.pid).toBe('p3');
  });

  it('a typist who keeps acting is busy again only within BUSY_MAX_TURNS of the typing start', () => {
    const { sch, room, conns } = setup(2);
    room.message(conns[1], { t: 'typing', on: true });
    const from = room.state!.turn;
    for (let i = 0; i < BUSY_MAX_TURNS + 5; i++) {
      if (i % 4 === 0) room.message(conns[1], { t: 'typing', on: true }); // refreshed within the expiry
      act(room, conns[1], { type: 'wait' });
      act(room, conns[0], { type: 'wait' });
      sch.advanceBy(100);
    }
    const s = room.state!;
    expect(s.turn - from).toBeGreaterThanOrEqual(BUSY_MAX_TURNS);
    expect(s.players.p2.busySince ?? null).toBeNull();
  });

  it('a seat that sent leave gets no character when the host starts soon after', () => {
    const { room, conns } = setup(3, { lobby: true });
    room.message(conns[2], { t: 'leave' });
    room.message(conns[0], { t: 'start' });
    expect(room.state!.party).toEqual(['p1', 'p2']);
    expect(room.seatList().map((x) => x.seat)).toEqual(['s1', 's2']);
  });

  it('a first action during the area hold starts its deadline when the hold ends, not at the hold maximum', () => {
    const { sch, room, conns } = setup(3);
    const s = room.state!;
    actorOf(s, 'p1').pos = { ...s.area.map.exit };
    act(room, conns[0], { type: 'transition' });
    let guard = 0;
    while (room.state!.area.index === 0 && guard++ < EXIT_COUNTDOWN_TURNS * 3) {
      for (const c of conns) room.message(c, { t: 'presence', state: 'playing' });
      sch.advanceBy(DEFAULT_TIMING.countdownTurnMs);
    }
    expect(room.state!.area.index).toBe(1);
    const n1 = room.n;
    const t0 = sch.now();
    sch.advanceBy(100);
    room.message(conns[0], { t: 'applied', n: n1 });
    act(room, conns[0], { type: 'wait' });
    sch.advanceBy(100);
    room.message(conns[1], { t: 'applied', n: n1 });
    room.message(conns[2], { t: 'applied', n: n1 });
    for (const c of conns.slice(1)) room.message(c, { t: 'presence', state: 'playing' });
    sch.advanceBy(room.options.deadlineMs + 50);
    expect(room.n).toBe(n1 + 1);
    expect(sch.now() - t0).toBeLessThan(DEFAULT_TIMING.areaHoldMaxMs);
  });
});

describe('MP3 D1: lobby messages, pings, typing busy, test switches', () => {
  it('ready toggles in the lobby (roster), is refused while playing and resets when a run starts', () => {
    const { room, conns } = setup(2, { lobby: true });
    room.message(conns[1], { t: 'ready', on: true });
    expect(conns[0].last('roster')!.seats.map((r) => r.ready)).toEqual([false, true]);
    room.message(conns[0], { t: 'ready', on: true });
    expect(conns[1].last('roster')!.seats.map((r) => r.ready)).toEqual([true, true]);
    room.message(conns[0], { t: 'start' });
    expect(conns[1].last('roster')!.seats.map((r) => r.ready)).toEqual([false, false]);
    room.message(conns[1], { t: 'ready', on: true });
    expect(conns[1].last('error')?.code).toBe('bad_phase');
  });

  it('profile changes name and colour with the hello rules (unique), lobby and ended only', () => {
    const { room, conns } = setup(3, { lobby: true });
    room.message(conns[2], { t: 'profile', name: 'p1', colour: PLAYER_COLOURS[1] });
    expect(room.seatList()[2]).toMatchObject({ name: 'p1 2', colour: PLAYER_COLOURS[2] });
    expect(conns[0].last('roster')!.seats[2]).toMatchObject({ name: 'p1 2', colour: PLAYER_COLOURS[2] });
    room.message(conns[2], { t: 'profile', name: 'Kari', colour: PLAYER_COLOURS[7] });
    expect(room.seatList()[2]).toMatchObject({ name: 'Kari', colour: PLAYER_COLOURS[7] });
    room.message(conns[0], { t: 'start' });
    expect(room.state!.players.p3.name).toBe('Kari');
    room.message(conns[2], { t: 'profile', name: 'Other', colour: PLAYER_COLOURS[8] });
    expect(conns[2].last('error')?.code).toBe('bad_phase');
    expect(room.seatList()[2].name).toBe('Kari');
  });

  it('world: the host picks a demo for everyone (room broadcast) and the run plays it; after a run it is staged', () => {
    const { room, conns } = setup(2, { lobby: true });
    room.message(conns[1], { t: 'world', demo: 'fixture-teen' });
    expect(conns[1].last('error')?.code).toBe('not_host');
    room.message(conns[0], { t: 'world', demo: 'no-such-world' });
    expect(conns[0].last('error')?.code).toBe('invalid');
    room.message(conns[0], { t: 'world', demo: 'fixture-teen' });
    for (const c of conns) expect(c.last('room')).toMatchObject({ room: { code: room.code, world: { title: room.world.world.meta.title } }, options: room.options });
    expect(room.world.source).toEqual({ demo: 'fixture-teen' });
    const n = conns[1].of('room').length;
    // the same world again: nothing to tell
    room.message(conns[0], { t: 'world', demo: 'fixture-teen' });
    expect(conns[1].of('room')).toHaveLength(n);
    room.message(conns[0], { t: 'start' });
    expect(conns[1].last('run')!.worldId).toBe(room.world.worldId);
    room.message(conns[0], { t: 'world', demo: 'fixture-western' });
    expect(conns[0].last('error')?.code).toBe('bad_phase');
    // the run ends: the next world is staged, listed, and played by the next start
    const before = room.state!;
    const lost = { ...before, status: 'lost' as const };
    (room as unknown as { state: GameState }).state = lost;
    (room as unknown as { settle: (a: GameState, b: GameState) => void }).settle(before, lost);
    const teenId = room.world.worldId;
    room.message(conns[0], { t: 'world', demo: 'fixture-western' });
    expect(room.world.worldId).toBe(teenId);
    expect(room.nextWorldId).not.toBe(teenId);
    expect(conns[1].last('room')!.room.world.id).toBe(room.nextWorldId);
    expect(room.info().world.id).toBe(room.nextWorldId);
    room.message(conns[0], { t: 'start' });
    expect(room.world.source).toEqual({ demo: 'fixture-western' });
    expect(conns[1].last('run')!.world).toBeTruthy();
  });

  it('an uploaded world is broadcast as room too', () => {
    const { m, room, conns, tokens } = setup(2, { lobby: true });
    const ship = upload(m, 'fixture-ship');
    expect(room.uploadWorld(tokens[0], ship)).toBe('ok');
    expect(conns[1].last('room')!.room.world).toMatchObject({ id: ship.worldId, title: ship.world.meta.title });
  });

  it('difficulty is a host option between runs (room broadcast), refused while playing; the run uses it', () => {
    const { room, conns } = setup(2, { lobby: true });
    room.message(conns[1], { t: 'options', difficulty: 'hard' });
    expect(conns[1].last('error')?.code).toBe('not_host');
    room.message(conns[0], { t: 'options', difficulty: 'hard' });
    expect(room.options.difficulty).toBe('hard');
    expect(conns[1].last('room')!.options).toMatchObject({ difficulty: 'hard' });
    room.message(conns[0], { t: 'options', deadlineMs: 3000 });
    expect(conns[1].last('room')!.options).toEqual({ maxPlayers: room.options.maxPlayers, deadlineMs: 3000, difficulty: 'hard' });
    room.message(conns[0], { t: 'start' });
    expect(room.state!.difficulty).toBe('hard');
    room.message(conns[0], { t: 'options', difficulty: 'gentle' });
    expect(conns[0].last('error')?.code).toBe('bad_phase');
    expect(room.options.difficulty).toBe('hard');
    // the deadline may still change during a run
    room.message(conns[0], { t: 'options', deadlineMs: 1500 });
    expect(room.options.deadlineMs).toBe(1500);
  });

  it('a ping is a chat line with no text at a tile of the area, sharing the 1/s chat rate', () => {
    const { sch, room, conns } = setup(2, { lobby: true });
    room.message(conns[0], { t: 'ping', kind: 'follow', x: 1, y: 1 });
    expect(conns[0].last('error')?.code).toBe('bad_phase');
    room.message(conns[0], { t: 'start' });
    sch.advanceBy(1000);
    const pos = actorOf(room.state!, 'p2').pos;
    room.message(conns[1], { t: 'ping', kind: 'help', x: pos.x, y: pos.y });
    const line = conns[0].last('chat')!.line;
    expect(line).toMatchObject({ seat: 's2', name: 'P2', text: '', ping: { kind: 'help', x: pos.x, y: pos.y, area: room.state!.area.index } });
    expect(room.chat.at(-1)).toEqual(line);
    // text and pings share the bucket
    room.message(conns[1], { t: 'chat', text: 'over here' });
    expect(conns[1].last('error')?.code).toBe('chat_rate');
    sch.advanceBy(1000);
    room.message(conns[1], { t: 'chat', text: 'over here' });
    room.message(conns[1], { t: 'ping', kind: 'wait', x: pos.x, y: pos.y });
    expect(conns[1].of('error').filter((e) => e.code === 'chat_rate')).toHaveLength(2);
    sch.advanceBy(1000);
    const map = room.state!.area.map;
    room.message(conns[1], { t: 'ping', kind: 'wait', x: map.width, y: 0 });
    expect(conns[1].last('error')?.code).toBe('invalid');
    // the socket's buckets: a ping takes from chat's
    const bk = new ConnBuckets(0);
    expect(bk.take('chat', 0)).toBe(true);
    expect(bk.take('ping', 0)).toBe(false);
    expect(bk.take('ping', 1000)).toBe(true);
    expect(bk.take('chat', 1000)).toBe(false);
  });

  it('typing keeps a busy it did not set: stopping it does not end a trade’s or menu’s safety', () => {
    const { room, conns } = setup(2);
    const s = () => room.state!;
    // p2 opens a trade (the client sends busy) and then chats
    room.message(conns[1], { t: 'input', area: s().area.index, turn: s().turn, actions: [], busy: true, intent: 'decide' });
    const since = s().players.p2.busySince;
    expect(since).not.toBeUndefined();
    room.message(conns[1], { t: 'typing', on: true });
    room.message(conns[1], { t: 'typing', on: false });
    expect(s().players.p2.busySince).toBe(since);
    room.message(conns[1], { t: 'typing', on: true });
    room.message(conns[1], { t: 'chat', text: 'one sec' });
    expect(s().players.p2.busySince).toBe(since);
    // the client ends the trade while still typing: typing holds busy now, and clears it when it stops
    room.message(conns[1], { t: 'typing', on: true });
    room.message(conns[1], { t: 'input', area: s().area.index, turn: s().turn, actions: [], busy: false, intent: 'decide' });
    expect(s().players.p2.busySince).not.toBeUndefined();
    room.message(conns[1], { t: 'typing', on: false });
    expect(s().players.p2.busySince ?? null).toBeNull();
    // typing on a seat that is not busy still sets and clears its own busy
    room.message(conns[1], { t: 'typing', on: true });
    expect(s().players.p2.busySince).not.toBeUndefined();
    room.message(conns[1], { t: 'typing', on: false });
    expect(s().players.p2.busySince ?? null).toBeNull();
  });

  it('the welcome of a playing room (late join) has the phase, the pid, its character in the snapshot, roster and chat', () => {
    const { sch, room, conns } = setup(2);
    room.message(conns[0], { t: 'chat', text: 'hi' });
    sch.advanceBy(1000);
    const late = new FakeConn();
    setupJoin(room, late, 'Kari');
    const w = late.last('welcome')!;
    expect(w).toMatchObject({ phase: 'playing', run: 1, you: { seat: 's3', pid: 'p3', host: false } });
    expect(w.world).toBeTruthy();
    expect(w.entries).toBeUndefined();
    const st = deserialize(room.world.world, w.snapshot!.state);
    expect(st.party).toEqual(['p1', 'p2', 'p3']);
    expect(st.players.p3).toMatchObject({ name: 'Kari' });
    expect(hashState(st)).toBe(hashState(room.state!));
    expect(w.roster.map((r) => [r.seat, r.pid, r.ready])).toEqual([['s1', 'p1', false], ['s2', 'p2', false], ['s3', 'p3', false]]);
    expect(w.chat.map((c) => c.text)).toEqual(['hi']);
  });

  it('the test switches are read only when set, never in production', async () => {
    const { testLimits, testRoomOptions, testSeed } = await import('../../server/index');
    expect(testSeed({})).toBeUndefined();
    expect(testLimits({})).toBeUndefined();
    expect(testRoomOptions({})).toEqual({});
    expect(testSeed({ ANYWORLD_TEST_SEED: '42', NODE_ENV: 'production' })).toBeUndefined();
    expect(testLimits({ ANYWORLD_TEST_LIMITS: '{"createsPer10Min":1000}', NODE_ENV: 'production' })).toBeUndefined();
    expect(testRoomOptions({ ANYWORLD_TEST_SEED: '42', ANYWORLD_TEST_LIMITS: '{}', ANYWORLD_TEST_TIMING: '{}', NODE_ENV: 'production' })).toEqual({});
    const seed = testSeed({ ANYWORLD_TEST_SEED: '42' })!;
    expect([seed(), seed()]).toEqual([42, 43]);
    expect(() => testSeed({ ANYWORLD_TEST_SEED: 'x' })).toThrow();
    expect(testLimits({ ANYWORLD_TEST_LIMITS: '{"createsPer10Min":1000,"socketsPerIp":64,"maxRooms":50}' })).toEqual({ limits: { createsPer10Min: 1000, socketsPerIp: 64 }, maxRooms: 50 });
    expect(() => testLimits({ ANYWORLD_TEST_LIMITS: '[1]' })).toThrow();
    const o = testRoomOptions({ ANYWORLD_TEST_SEED: '9', ANYWORLD_TEST_LIMITS: '{"upgradesPerMin":500}' });
    expect(o.limits).toEqual({ upgradesPerMin: 500 });
    // the seed reaches the runs through RoomDeps.seed
    const sch = new ManualScheduler();
    const m = new RoomManager({ dir, engineVersion: 'v1', scheduler: sch, log: () => {}, seed: o.seed });
    const c = m.create({ demo: 'fixture-western' });
    if (!c.ok) throw new Error(c.error);
    const conn = new FakeConn();
    m.hello(conn, hello(c.code, c.token, 'Ann'));
    c.room.message(conn, { t: 'start' });
    expect(c.room.seed).toBe(9);
    expect(c.room.state!.seed).toBe(9);
  });
});
