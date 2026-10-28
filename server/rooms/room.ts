/**
 * One room (MP2 design §3–§6): seats and roster, phases (lobby → playing → ended → play again),
 * the engine state moved only by log entries (src/net/log.ts applyEntry), the turn clock
 * (clock.ts), chat, typing, canned GM entries, hash checks and the 2-minute rule.
 *
 * Transport-agnostic: a connection is a `Conn` (send a ServerMsg, close with a code); the socket
 * layer (ws.ts) parses frames and calls hello / message / disconnect. Time comes from an injected
 * Scheduler, and the room keeps one timer, for the next resolve or the next wake (clock.ts).
 *
 * An entry is applied, appended to the store, then broadcast; an entry whose result is the same
 * state object (every action refused, a flag already set) is neither appended nor broadcast.
 * `n` is the number of entries applied in this run: the next entry's n, and the n of a snapshot,
 * a hash report or an `applied` message (all "the state after n entries").
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  createGame,
  deserialize,
  hashState,
  readyPlayers,
  registerWorld,
  serialize,
  stepTurn,
  worldIdOf,
} from '../../src/engine/index';
import { FREE_ACTIONS } from '../../src/engine/party';
import type { GameState, PlayerAction, PlayerId, TurnInput, TurnOutcome } from '../../src/engine/types';
import { parseWorld } from '../../src/schema';
import type { WorldSpec } from '../../src/schema/world';
import { gmHooksFor, newHookTracker, OfflineGmDirector, sanitizeResponse, type GmHookEvent, type GmTranslate, type HookTracker, type OfflineGmKey } from '../../src/gm/offline';
import { applyEntry, changedArea, type Applied } from '../../src/net/log';
import {
  cleanChat,
  CLOSE,
  LIMITS,
  LogEntrySchema,
  PLAYER_COLOURS,
  type ChatLine,
  type ClientMsg,
  type ClosedReason,
  type ErrorCode,
  type Hello,
  type InputMsg,
  type Intent,
  type LogEntry,
  type LogEntryBody,
  type Phase,
  type Presence,
  type Refused,
  type RefusedCode,
  type RoomInfo,
  type RoomOptions,
  type RosterEntry,
  type SeatPresence,
  type ServerMsg,
  type Welcome,
} from '../../src/net/protocol';
import { formatMessage } from '../../src/client/i18n/message-format';
import en from '../../src/client/i18n/en';
import nb from '../../src/client/i18n/nb';
import { nextResolve, type ClockDecision, type ClockView, type PendingInput } from './clock';
import type { RoomTiming, Scheduler, TimerId } from './timing';
import { linesToReplay, type LoadedRoom, type RoomFile, type RoomStore, type SeatRecord, type WorldFile } from './store';
import type { DemoWorlds } from './worlds';

/** rooms create their runs with this exit countdown (≈ 10 s at countdownTurnMs; a constant, not derived from the timing) */
export const EXIT_COUNTDOWN_TURNS = 10;
/** entries between snapshots */
export const SNAPSHOT_EVERY = 100;
/** entries kept for welcome after a reconnect */
export const RING_SIZE = 512;
/** server hashes kept (one per LIMITS.hashEvery entries) */
export const HASH_RING = 64;
/** 'illegal' outcomes a minute per player above which the room logs a line (design §9) */
export const ILLEGAL_LOG_PER_MIN = 20;
/** the GM's weirdness in rooms (the offline director does not read it) */
const ROOM_WEIRDNESS = 0.5;

/** one connection as the room sees it */
export interface Conn {
  send(msg: ServerMsg): void;
  close(code: number, reason?: string): void;
}

export interface RoomWorld {
  world: WorldSpec;
  worldId: string;
  source: WorldFile['source'];
}

export interface RoomDeps {
  timing: RoomTiming;
  scheduler: Scheduler;
  /** null: nothing is written (tests) */
  store: RoomStore | null;
  demos: DemoWorlds;
  log?: (line: string) => void;
  /** called once when the room closes (the manager removes its files and keeps a tombstone) */
  onClose?: (room: Room, reason: ClosedReason) => void;
  /** a world the room no longer plays (the manager unregisters an upload nobody else uses) */
  releaseWorld?: (worldId: string) => void;
  /** run seeds and seat tokens (default: node:crypto) */
  seed?: () => number;
  token?: () => string;
}

interface Seat {
  id: string;
  tokenHash: string;
  name: string;
  colour: (typeof PLAYER_COLOURS)[number];
  pid: PlayerId | null;
  joinedAt: number;
  /** sent `leave` */
  quit: boolean;
  conn: Conn | null;
  connectedSince: number | null;
  offSince: number | null;
  /** when the 2-minute rule acts (a lobby seat is removed, a character leaves the map); null = not armed */
  awayAt: number | null;
  presence: Presence;
  /** the last input or presence change */
  lastActiveAt: number;
  typingUntil: number | null;
  lastChatAt: number;
  /** the roster presence last shown, and since when */
  shown: SeatPresence | null;
  since: number;
}

interface Pending {
  action: PlayerAction;
  intent: Intent;
  at: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

function newSeed(): number {
  return randomInt(1, 2 ** 31 - 1);
}

/** the offer labels of the canned GM in the world's language */
export function gmTranslate(language: string): GmTranslate {
  const lang = language.toLowerCase();
  const cat: Record<string, string> = lang.startsWith('nb') || lang.startsWith('no') ? nb : en;
  return (key: OfflineGmKey, params?: Record<string, string | number>) => formatMessage(cat[key] ?? en[key], params, lang);
}

/** may `pid` leave the map now (MP2 design §3 rule 5; the engine's own check is party.ts leaveFailure) */
export function canLeave(state: GameState, pid: PlayerId): boolean {
  if (state.status !== 'playing' || !state.party.includes(pid) || state.party.length < 2) return false;
  return state.party.some((id) => id !== pid && !state.players[id].down);
}

/** the id addPlayer gives the next player (p1, p2…, never reused; the join entry is checked against it) */
function nextPid(state: GameState): PlayerId {
  let n = 0;
  for (const id of Object.keys(state.players)) n = Math.max(n, Number(/^p(\d+)$/.exec(id)?.[1] ?? 0));
  return `p${n + 1}`;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  engineVersion: string;
  options: RoomOptions;
  phase: Phase = 'lobby';
  /** 0 in a fresh lobby; each start makes a new run */
  run = 0;
  seed = 0;
  world: RoomWorld;
  /** a world uploaded in the ended phase, played from the next start */
  private nextWorld: RoomWorld | null = null;
  state: GameState | null = null;
  /** entries applied in this run */
  n = 0;
  private ring: LogEntry[] = [];
  private hashes = new Map<number, string>();
  private tracker: HookTracker = newHookTracker();
  private director: OfflineGmDirector;
  chat: ChatLine[] = [];
  private nextChatId = 1;
  private seats: Seat[] = [];
  private nextSeat = 1;
  host: string | null = null;
  private pending = new Map<PlayerId, Pending>();
  private firstAt: number | null = null;
  private lastResolveAt: number;
  /** after an area change: until when, for which n, and the connected seats not yet `applied` */
  private hold: { until: number; n: number; waitFor: Set<string> } | null = null;
  private timer: TimerId | null = null;
  /** the last input or chat (the 2-hour idle close) */
  lastActivityAt: number;
  closed = false;
  /** the stored snapshot (a room file rewrite between snapshots keeps it) */
  private stored: { snapshot: RoomFile['snapshot']; hooks: HookTracker | null } = { snapshot: null, hooks: null };
  private lastRoster = '';
  private lastClock = '';
  private lastClockAt = -Infinity;
  private clockDue: number | null = null;
  private evaluating = false;
  /** 'illegal' outcomes per player in the current minute (design §9: a log line above ILLEGAL_LOG_PER_MIN) */
  private illegal = new Map<PlayerId, { since: number; count: number }>();

  private constructor(
    code: string,
    world: RoomWorld,
    options: RoomOptions,
    engineVersion: string,
    createdAt: number,
    private readonly deps: RoomDeps,
  ) {
    this.code = code;
    this.world = world;
    this.options = options;
    this.engineVersion = engineVersion;
    this.createdAt = createdAt;
    this.lastResolveAt = createdAt;
    this.lastActivityAt = createdAt;
    this.director = new OfflineGmDirector({ t: gmTranslate(world.world.meta.language) });
  }

  /** a new room in the lobby phase (its files are written at once) */
  static create(code: string, world: RoomWorld, options: RoomOptions, engineVersion: string, deps: RoomDeps): Room {
    const room = new Room(code, world, options, engineVersion, deps.scheduler.now(), deps);
    registerWorld(world.world);
    deps.store?.writeWorld(code, { format: 1, worldId: world.worldId, world: world.world, source: world.source });
    room.persistRoom(false);
    return room;
  }

  /**
   * A stored room: the world is validated again (stored files are untrusted too), the snapshot
   * deserialized and the log replayed with applyEntry (the GM tracker rebuilt with gmHooksFor, the
   * director not asked). Every seat is off and the room sleeps until one reconnects. Throws when a
   * file does not make sense.
   */
  static load(loaded: LoadedRoom, deps: RoomDeps): Room {
    const f = loaded.room;
    const pw = parseWorld(loaded.world.world, { strictKeys: true });
    if (!pw.ok) throw new Error(`stored world is invalid: ${pw.errors.slice(0, 3).join('; ')}`);
    const worldId = worldIdOf(pw.world);
    if (worldId !== loaded.world.worldId) throw new Error(`stored world id ${loaded.world.worldId} differs from ${worldId}`);
    const now = deps.scheduler.now();
    const room = new Room(f.code, { world: pw.world, worldId, source: loaded.world.source }, f.options, f.engineVersion, f.createdAt, deps);
    registerWorld(pw.world);
    const { entries, seats, chat } = linesToReplay(f, loaded.lines);
    room.phase = f.phase;
    room.run = f.run;
    room.seed = f.seed;
    room.host = f.host;
    for (const r of seats) {
      if (r.removed) continue;
      room.seats.push(room.seatFrom(r, now));
    }
    room.nextSeat = Math.max(f.nextSeat ?? 1, 1 + Math.max(0, ...seats.map((s) => Number(s.seat.slice(1)) || 0)));
    room.chat = [...f.chat, ...chat].slice(-LIMITS.chatHistory);
    room.nextChatId = 1 + Math.max(0, ...room.chat.map((c) => c.id));
    room.stored = { snapshot: f.snapshot, hooks: f.hooks };
    if (f.snapshot) {
      let state = deserialize(pw.world, f.snapshot.state);
      room.n = f.snapshot.n;
      room.tracker = f.hooks ? { ...f.hooks, bossesSeen: [...f.hooks.bossesSeen] } : newHookTracker(state.turn);
      if (room.n % LIMITS.hashEvery === 0) room.hashes.set(room.n, hashState(state));
      for (const raw of entries) {
        const e = LogEntrySchema.parse(raw);
        const r = applyEntry(pw.world, state, e);
        if (e.k === 'turn') gmHooksFor(pw.world, state, r.state, r.events, room.tracker);
        state = r.state;
        room.record(e, state);
      }
      room.state = state;
      if (room.phase === 'playing' && state.status !== 'playing') room.phase = 'ended';
    } else if (room.phase !== 'lobby') {
      throw new Error(`phase ${room.phase} without a snapshot`);
    }
    room.lastResolveAt = now;
    room.lastActivityAt = now;
    return room;
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  private seatFrom(r: SeatRecord, now: number): Seat {
    const colour = (PLAYER_COLOURS as readonly string[]).includes(r.colour) ? (r.colour as Seat['colour']) : PLAYER_COLOURS[0];
    return {
      id: r.seat,
      tokenHash: r.tokenHash,
      name: r.name,
      colour,
      pid: r.pid,
      joinedAt: r.joinedAt,
      quit: !!r.left,
      conn: null,
      connectedSince: null,
      offSince: now,
      awayAt: null,
      presence: 'playing',
      lastActiveAt: now,
      typingUntil: null,
      lastChatAt: -Infinity,
      shown: null,
      since: now,
    };
  }

  private record(e: LogEntry, state: GameState): void {
    this.n = e.n + 1;
    this.ring.push(e);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.n % LIMITS.hashEvery === 0) {
      this.hashes.set(this.n, hashState(state));
      if (this.hashes.size > HASH_RING) this.hashes.delete(this.hashes.keys().next().value!);
    }
  }

  private seatRecord(s: Seat, removed = false): SeatRecord {
    return { seat: s.id, tokenHash: s.tokenHash, name: s.name, colour: s.colour, pid: s.pid, joinedAt: s.joinedAt, ...(s.quit ? { left: true } : {}), ...(removed ? { removed: true } : {}) };
  }

  private persistSeat(s: Seat, removed = false): void {
    this.deps.store?.append(this.code, { seat: this.seatRecord(s, removed) });
  }

  /** `name` made unique in the room (" 2", " 3"…), within LIMITS.nameMax code points */
  private uniqueName(name: string, self: Seat | null): string {
    const taken = new Set(this.seats.filter((s) => s !== self).map((s) => s.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let k = 2; ; k++) {
      const suffix = ` ${k}`;
      const base = [...name].slice(0, LIMITS.nameMax - suffix.length).join('');
      const cand = `${base}${suffix}`;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
  }

  /** `colour`, or the first free one when another seat has it */
  private uniqueColour(colour: string, self: Seat | null): Seat['colour'] {
    const taken = new Set(this.seats.filter((s) => s !== self).map((s) => s.colour));
    if ((PLAYER_COLOURS as readonly string[]).includes(colour) && !taken.has(colour as Seat['colour'])) return colour as Seat['colour'];
    return PLAYER_COLOURS.find((c) => !taken.has(c)) ?? PLAYER_COLOURS[0];
  }

  private makeSeat(name: string, colour: string, token: string): Seat {
    const now = this.deps.scheduler.now();
    const s: Seat = {
      id: `s${this.nextSeat++}`,
      tokenHash: hashToken(token),
      name: '',
      colour: PLAYER_COLOURS[0],
      pid: null,
      joinedAt: now,
      quit: false,
      conn: null,
      connectedSince: null,
      offSince: now,
      awayAt: null,
      presence: 'playing',
      lastActiveAt: now,
      typingUntil: null,
      lastChatAt: -Infinity,
      shown: null,
      since: now,
    };
    s.name = this.uniqueName(name, s);
    s.colour = this.uniqueColour(colour, s);
    this.seats.push(s);
    return s;
  }

  /**
   * The creator's seat (POST /api/rooms): the host, not yet connected; hello { token } binds it
   * (and brings its name and colour). Null when the room is full or closed.
   */
  addSeat(name = 'Host', colour: string = PLAYER_COLOURS[0]): { seat: string; token: string } | null {
    if (this.closed || this.seats.length >= this.options.maxPlayers) return null;
    const token = (this.deps.token ?? newToken)();
    const s = this.makeSeat(name, colour, token);
    // a seat added to a running game waits for its hello to join (the hello's name is its name)
    s.awayAt = null;
    if (this.host === null) this.host = s.id;
    this.persistSeat(s);
    this.persistRoom(false);
    return { seat: s.id, token };
  }

  private seatOf(conn: Conn): Seat | undefined {
    return this.seats.find((s) => s.conn === conn);
  }

  private connected(): Seat[] {
    return this.seats.filter((s) => s.conn !== null);
  }

  get anyConnected(): boolean {
    return this.seats.some((s) => s.conn !== null);
  }

  /** the host is a connected seat when there is one: the one connected longest takes over */
  private ensureHost(): void {
    const cur = this.seats.find((s) => s.id === this.host);
    if (cur?.conn) return;
    const next = this.connected().sort((a, b) => (a.connectedSince ?? 0) - (b.connectedSince ?? 0) || a.joinedAt - b.joinedAt)[0];
    if (next) {
      if (next.id !== this.host) this.log(`host is now ${next.id}`);
      this.host = next.id;
    } else if (!cur) this.host = this.seats[0]?.id ?? null;
  }

  private onMap(pid: PlayerId | null): pid is PlayerId {
    return pid !== null && !!this.state && this.state.party.includes(pid);
  }

  /** where a late joiner or a returning player appears: next to the host's character, else the lead */
  private nearPid(): PlayerId {
    const h = this.seats.find((s) => s.id === this.host);
    return h && this.onMap(h.pid) ? h.pid : this.state!.party[0];
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /**
   * A hello for this room (the engine version is checked by the caller): a new seat, or the seat of
   * the token. On success the room sends `welcome` and subscribes the connection in the same step
   * and returns null; otherwise the refusal to send (the caller sends it and closes the socket).
   */
  hello(conn: Conn, h: Hello): Refused | null {
    if (this.closed) return refused('room_closed', 'This room is closed.');
    const now = this.deps.scheduler.now();
    let seat: Seat | undefined;
    let token: string;
    if (h.token) {
      seat = this.seats.find((s) => s.tokenHash === hashToken(h.token!));
      if (!seat) return refused('bad_token', 'That seat is not in this room.');
      token = h.token;
    } else {
      if (this.seats.length >= this.options.maxPlayers) return refused('room_full', 'This room is full.');
      token = (this.deps.token ?? newToken)();
      seat = this.makeSeat(h.name, h.colour, token);
      this.persistSeat(seat);
    }
    return this.guard(() => {
      const s = seat!;
      // a second socket with the same token replaces the first (a new tab)
      if (s.conn) {
        const old = s.conn;
        s.conn = null;
        safeClose(old, CLOSE.replaced, 'replaced');
      }
      // the 2-minute timer is cancelled before anything else
      s.awayAt = null;
      const wasEmpty = !this.anyConnected;
      let changed = false;
      if (s.pid === null) {
        const name = this.uniqueName(h.name, s);
        const colour = this.uniqueColour(h.colour, s);
        changed = name !== s.name || colour !== s.colour;
        s.name = name;
        s.colour = colour;
      }
      if (s.quit) {
        s.quit = false;
        changed = true;
      }
      if (wasEmpty) this.wake(s);
      if (this.phase === 'playing' && this.state && this.state.status === 'playing') {
        if (s.pid === null) {
          const pid = nextPid(this.state);
          s.pid = pid;
          changed = true;
          this.push({ k: 'join', seat: s.id, name: s.name, pid, near: this.nearPid() });
        } else if (this.state.players[s.pid]?.left) {
          this.push({ k: 'return', pid: s.pid, near: this.nearPid() });
        } else if (this.state.players[s.pid]?.away) {
          this.push({ k: 'back', pid: s.pid });
        }
      }
      if (changed) this.persistSeat(s);
      // bind and welcome in one synchronous step: no entry is lost or sent twice
      s.conn = conn;
      s.connectedSince = now;
      s.offSince = null;
      s.presence = 'playing';
      s.lastActiveAt = now;
      this.ensureHost();
      conn.send(this.welcome(s, token, h));
      this.evaluate();
      return null;
    }, refused('room_closed', 'This room is closed.'));
  }

  /** the first seat connects to a sleeping room: the other seats' away timers start now */
  private wake(self: Seat): void {
    const now = this.deps.scheduler.now();
    this.lastResolveAt = now;
    for (const o of this.seats) {
      if (o === self || o.conn) continue;
      o.awayAt = now + this.deps.timing.awayMs;
      // (after a restart the engine does not know yet that they are away)
      if (this.phase === 'playing' && this.state && this.onMap(o.pid) && !this.state.players[o.pid].away) this.push({ k: 'away', pid: o.pid });
    }
  }

  private welcome(s: Seat, token: string, h: Hello): Welcome {
    const msg: Welcome = {
      t: 'welcome',
      room: this.info(),
      you: { seat: s.id, pid: s.pid, token, host: this.host === s.id },
      roster: this.roster(),
      phase: this.phase,
      run: this.run,
      options: { ...this.options },
      worldId: this.world.worldId,
      chat: this.chat.slice(),
    };
    if (h.run !== this.run || this.run === 0) msg.world = this.world.world;
    if (this.state) {
      const ringStart = this.ring.length ? this.ring[0].n : this.n;
      if (h.run === this.run && h.lastN !== undefined && h.lastN <= this.n && h.lastN >= ringStart) {
        msg.entries = this.ring.slice(h.lastN - ringStart);
      } else {
        msg.snapshot = { n: this.n, state: serialize(this.state) };
      }
    }
    return msg;
  }

  /** a socket closed (or missed its pings): the seat is off; a replaced socket's late close does nothing */
  disconnect(conn: Conn): void {
    const s = this.seatOf(conn);
    if (!s || this.closed) return;
    this.guard(() => {
      this.goOff(s);
      this.evaluate();
      this.closeIfEmpty();
    }, undefined);
  }

  private goOff(s: Seat): void {
    const now = this.deps.scheduler.now();
    this.stopTyping(s, true);
    s.conn = null;
    s.connectedSince = null;
    s.offSince = now;
    s.awayAt = now + this.deps.timing.awayMs;
    this.hold?.waitFor.delete(s.id);
    if (this.phase === 'playing' && this.onMap(s.pid)) this.push({ k: 'away', pid: s.pid });
    this.ensureHost();
  }

  /** a message from a bound connection (hello is handled by hello()) */
  message(conn: Conn, msg: ClientMsg): void {
    const s = this.seatOf(conn);
    if (!s || this.closed) return;
    this.guard(() => {
      const now = this.deps.scheduler.now();
      switch (msg.t) {
        case 'hello':
          return this.error(s, 'invalid', 'already joined');
        case 'input':
          this.input(s, msg);
          break;
        case 'presence':
          s.presence = msg.state;
          s.lastActiveAt = now;
          break;
        case 'typing':
          if (msg.on) this.startTyping(s);
          else this.stopTyping(s, true);
          break;
        case 'chat':
          this.say(s, msg.text);
          break;
        case 'hash':
          this.checkHash(s, msg.n, msg.h);
          break;
        case 'applied':
          if (this.hold && msg.n >= this.hold.n) {
            this.hold.waitFor.delete(s.id);
            if (this.hold.waitFor.size === 0) this.hold = null;
          }
          break;
        case 'start':
          this.start(s, msg.demo);
          break;
        case 'options':
          this.setOptions(s, msg);
          break;
        case 'leave':
          s.quit = true;
          this.persistSeat(s);
          this.goOff(s);
          safeClose(conn, 1000, 'left');
          this.evaluate();
          this.closeIfEmpty();
          return;
      }
      this.evaluate();
    }, undefined);
  }

  private error(s: Seat, code: ErrorCode, message: string): void {
    s.conn?.send({ t: 'error', code, message });
  }

  // -------------------------------------------------------------------------
  // Inputs, typing, chat, hashes
  // -------------------------------------------------------------------------

  private input(s: Seat, m: InputMsg): void {
    const state = this.state;
    if (this.phase !== 'playing' || !state || !this.onMap(s.pid)) return this.error(s, 'bad_phase', 'not playing');
    if (m.area !== state.area.index || m.turn > state.turn || state.turn - m.turn > LIMITS.staleTurns) return this.error(s, 'stale', 'that input was for an older turn; decide again');
    const now = this.deps.scheduler.now();
    s.lastActiveAt = now;
    this.lastActivityAt = now;
    const pid = s.pid;
    const free = m.actions.filter((a) => FREE_ACTIONS.has(a.type));
    const turnActs = m.actions.filter((a) => !FREE_ACTIONS.has(a.type));
    const area = state.area.index;
    if (free.length || m.busy !== undefined) {
      const input: TurnInput = { playerId: pid, ...(free.length ? { actions: free } : {}), ...(m.busy !== undefined ? { busy: m.busy } : {}) };
      this.pushTurn([input], false, true);
    }
    if (turnActs.length && this.state && this.state.status === 'playing' && this.state.area.index === area && this.onMap(pid)) {
      this.pending.set(pid, { action: turnActs[0], intent: m.intent, at: now });
      if (this.firstAt === null) this.firstAt = Math.max(now, this.hold?.until ?? now);
    }
  }

  private startTyping(s: Seat): void {
    const was = s.typingUntil !== null;
    s.typingUntil = this.deps.scheduler.now() + this.deps.timing.typingExpiryMs;
    if (was) return;
    this.broadcast({ t: 'typing', seat: s.id, on: true });
    this.busyEntry(s, true);
  }

  private stopTyping(s: Seat, entry: boolean): void {
    if (s.typingUntil === null) return;
    s.typingUntil = null;
    this.broadcast({ t: 'typing', seat: s.id, on: false });
    if (entry) this.busyEntry(s, false);
  }

  private busyEntry(s: Seat, busy: boolean): void {
    if (this.phase === 'playing' && this.onMap(s.pid)) this.pushTurn([{ playerId: s.pid, busy }], false, false);
  }

  private say(s: Seat, text: string): void {
    const clean = cleanChat(text);
    if (clean === null) return this.error(s, 'chat_long', `at most ${LIMITS.chatMax} characters`);
    const now = this.deps.scheduler.now();
    if (now - s.lastChatAt < 1000 / LIMITS.rates.chat.perSec) return this.error(s, 'chat_rate', 'one message a second');
    s.lastChatAt = now;
    this.lastActivityAt = now;
    const line: ChatLine = { id: this.nextChatId++, seat: s.id, name: s.name, colour: s.colour, text: clean, at: now };
    this.chat.push(line);
    if (this.chat.length > LIMITS.chatHistory) this.chat.shift();
    this.deps.store?.append(this.code, { chat: line });
    this.broadcast({ t: 'chat', line });
    this.stopTyping(s, true);
  }

  private checkHash(s: Seat, n: number, h: string): void {
    const expected = this.hashes.get(n);
    if (!this.state || expected === undefined || expected === h) return;
    this.log(`desync seat ${s.id} at n=${n}`);
    s.conn?.send({ t: 'snapshot', run: this.run, n: this.n, state: serialize(this.state) });
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private start(s: Seat, demo: string | undefined): void {
    if (this.host !== s.id) return this.error(s, 'not_host', 'only the host can start');
    if (this.phase === 'playing') return this.error(s, 'bad_phase', 'the run is on');
    let world = this.nextWorld ?? this.world;
    if (demo !== undefined) {
      const d = this.deps.demos.get(demo);
      if (!d) return this.error(s, 'invalid', `no demo world "${demo}"`);
      world = { world: d.world, worldId: d.worldId, source: { demo } };
    }
    this.newRun(world);
  }

  /** a new run with every seat in the lobby, or (play again) every seat connected or off for less than 2 minutes */
  private newRun(world: RoomWorld): void {
    const now = this.deps.scheduler.now();
    if (this.phase === 'ended') {
      for (const s of this.seats.slice()) {
        if (s.conn || (s.offSince !== null && now - s.offSince < this.deps.timing.awayMs)) continue;
        this.removeSeat(s);
      }
    }
    const worldChanged = world.worldId !== this.world.worldId;
    if (worldChanged) {
      const old = this.world;
      this.world = world;
      this.director = new OfflineGmDirector({ t: gmTranslate(world.world.meta.language) });
      registerWorld(world.world);
      this.deps.store?.writeWorld(this.code, { format: 1, worldId: world.worldId, world: world.world, source: world.source });
      this.deps.releaseWorld?.(old.worldId);
    }
    this.nextWorld = null;
    this.run++;
    this.seed = (this.deps.seed ?? newSeed)();
    this.n = 0;
    this.ring = [];
    this.hashes.clear();
    this.pending.clear();
    this.firstAt = null;
    this.hold = null;
    const state = createGame(world.world, {
      seed: this.seed,
      players: this.seats.map((s) => ({ name: s.name })),
      difficulty: this.options.difficulty,
      exitCountdownTurns: EXIT_COUNTDOWN_TURNS,
    });
    this.seats.forEach((s, i) => {
      s.pid = state.party[i];
      this.persistSeat(s);
    });
    this.state = state;
    this.tracker = newHookTracker(state.turn);
    this.phase = 'playing';
    this.lastResolveAt = now;
    this.hashes.set(0, hashState(state));
    this.snapshot();
    this.broadcast({ t: 'run', run: this.run, ...(worldChanged ? { world: world.world } : {}), worldId: world.worldId, snapshot: { n: 0, state: serialize(state) } });
    this.log(`run ${this.run} started (${this.seats.length} players, seed ${this.seed})`);
    // a seat that is off at the start gets its character and the 2-minute rule
    for (const s of this.seats) {
      if (s.conn) continue;
      if (s.awayAt === null) s.awayAt = (s.offSince ?? now) + this.deps.timing.awayMs;
      if (this.onMap(s.pid)) this.push({ k: 'away', pid: s.pid });
    }
    this.askGm([{ hook: 'intro', area: state.area.index, turn: state.turn }]);
  }

  private removeSeat(s: Seat): void {
    this.seats = this.seats.filter((x) => x !== s);
    this.persistSeat(s, true);
    if (s.conn) safeClose(s.conn, CLOSE.closed, 'removed');
    if (this.host === s.id) {
      this.host = null;
      this.ensureHost();
    }
    this.log(`seat ${s.id} removed`);
  }

  private setOptions(s: Seat, m: Extract<ClientMsg, { t: 'options' }>): void {
    if (this.host !== s.id) return this.error(s, 'not_host', 'only the host can change the options');
    if (m.maxPlayers !== undefined && m.maxPlayers < this.seats.length) return this.error(s, 'invalid', 'fewer places than players');
    this.options = { ...this.options, ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}), ...(m.maxPlayers !== undefined ? { maxPlayers: m.maxPlayers } : {}) };
    this.persistRoom(false);
  }

  /**
   * POST /api/rooms/:code/world (C4): the host uploads a new world (already validated). In the lobby
   * it replaces the room's world at once; after a run it is played from the next start.
   */
  uploadWorld(token: string, world: RoomWorld): 'ok' | 'bad_token' | 'not_host' | 'bad_phase' {
    const s = this.seats.find((x) => x.tokenHash === hashToken(token));
    if (!s) return 'bad_token';
    if (this.host !== s.id) return 'not_host';
    if (this.phase === 'playing' || this.closed) return 'bad_phase';
    registerWorld(world.world);
    if (this.phase === 'ended') {
      this.nextWorld = world;
      return 'ok';
    }
    const old = this.world;
    this.world = world;
    this.director = new OfflineGmDirector({ t: gmTranslate(world.world.meta.language) });
    this.deps.store?.writeWorld(this.code, { format: 1, worldId: world.worldId, world: world.world, source: world.source });
    if (old.worldId !== world.worldId) this.deps.releaseWorld?.(old.worldId);
    return 'ok';
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  /**
   * Applies an entry, appends it to the store, then broadcasts it. A no-op (the same state object)
   * is dropped and returns null. After a turn entry the GM is asked about its moments; after any
   * entry the run end, an area change and the snapshot cadence are checked.
   */
  private push(body: LogEntryBody): (Applied & { before: GameState }) | null {
    const before = this.state;
    if (!before || this.closed) return null;
    const e = { ...body, n: this.n, run: this.run } as LogEntry;
    const r = applyEntry(this.world.world, before, e);
    if (r.state === before) return null;
    this.state = r.state;
    this.record(e, r.state);
    this.deps.store?.append(this.code, { e });
    this.broadcast({ t: 'entries', run: this.run, es: [e] });
    if (e.k === 'turn') this.countIllegal(r.outcomes);
    let hooks: GmHookEvent[] = [];
    if (e.k === 'turn') hooks = gmHooksFor(this.world.world, before, r.state, r.events, this.tracker);
    this.settle(before, r.state);
    if (hooks.length) this.askGm(hooks);
    return { ...r, before };
  }

  /** a client whose actions keep coming back 'illegal' is out of step with the engine (or a bad bot): one log line a minute */
  private countIllegal(outcomes: readonly TurnOutcome[]): void {
    const now = this.deps.scheduler.now();
    for (const o of outcomes) {
      if (o.ok || o.reason !== 'illegal') continue;
      let c = this.illegal.get(o.playerId);
      if (!c || now - c.since >= 60_000) this.illegal.set(o.playerId, (c = { since: now, count: 0 }));
      if (++c.count === ILLEGAL_LOG_PER_MIN + 1) this.log(`${o.playerId}: more than ${ILLEGAL_LOG_PER_MIN} illegal actions in a minute (last ${JSON.stringify(o.action)}: ${o.detail ?? ''})`);
    }
  }

  /** a turn entry; a no-op with refused actions sends the actor(s) a `refusal` */
  private pushTurn(inputs: TurnInput[], advance: boolean, tellRefusals: boolean): boolean {
    const before = this.state;
    if (!before) return false;
    const r = this.push({ k: 'turn', inputs, advance });
    if (r) return true;
    if (tellRefusals && inputs.some((i) => i.actions?.length)) {
      const out = stepTurn(before, inputs, { world: this.world.world, advance });
      for (const s of this.seats) {
        const reasons = out.outcomes
          .filter((o) => o.playerId === s.pid && !o.ok)
          .slice(0, LIMITS.actionsPerInput)
          .map((o) => ({ action: o.action, reason: (o.reason ?? 'illegal').slice(0, 64), ...(o.detail ? { detail: o.detail.slice(0, 400) } : {}) }));
        if (reasons.length) s.conn?.send({ t: 'refusal', reasons });
      }
    }
    return false;
  }

  /** the canned GM answers each moment; a non-empty answer becomes a gm entry */
  private askGm(hooks: GmHookEvent[]): void {
    for (const h of hooks) {
      const state = this.state;
      if (!state || state.status !== 'playing') return;
      const res = this.director.respondSync({
        ...h,
        ctx: { world: this.world.world, state, difficulty: state.difficulty ?? this.options.difficulty, weirdness: ROOM_WEIRDNESS, recentLog: state.log.slice(-12), areaEnteredTurn: this.tracker.areaEnteredTurn },
      });
      const clean = res ? sanitizeResponse(res) : null;
      if (!clean) continue;
      const body = { k: 'gm' as const, hook: h.hook, actions: clean.actions };
      // (clients validate entries with the same schema: an entry they would drop is never sent)
      if (!LogEntrySchema.safeParse({ ...body, n: 0, run: 0 }).success) {
        this.log(`gm answer to ${h.hook} dropped (does not match the protocol)`);
        continue;
      }
      this.push(body);
    }
  }

  /** after an entry: run end, area change (snapshot, hold, pending cleared), snapshot cadence */
  private settle(before: GameState, after: GameState): void {
    const now = this.deps.scheduler.now();
    if (after.status !== 'playing' && this.phase === 'playing') {
      this.phase = 'ended';
      this.pending.clear();
      this.firstAt = null;
      this.hold = null;
      this.snapshot();
      this.log(`run ${this.run} ${after.status} after ${this.n} entries`);
      return;
    }
    if (changedArea(before, after)) {
      this.pending.clear();
      this.firstAt = null;
      const waitFor = new Set(this.connected().map((s) => s.id));
      this.hold = waitFor.size ? { until: now + this.deps.timing.areaHoldMaxMs, n: this.n, waitFor } : null;
      this.snapshot();
      return;
    }
    if (this.n % SNAPSHOT_EVERY === 0) this.snapshot();
  }

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  private isActive(s: Seat, now: number): boolean {
    if (!s.conn || s.presence !== 'playing' || s.typingUntil !== null || s.pid === null || !this.state) return false;
    if (this.state.players[s.pid]?.pendingChoice) return false;
    return now - s.lastActiveAt < this.deps.timing.idleActiveMs;
  }

  /** the clock's view of the room now (pending inputs of players no longer standing on the map are dropped) */
  clockView(now = this.deps.scheduler.now()): ClockView {
    const state = this.state!;
    const ready = readyPlayers(state, { world: this.world.world });
    for (const pid of [...this.pending.keys()]) {
      const ps = state.players[pid];
      if (!state.party.includes(pid) || !ps || ps.down) this.pending.delete(pid);
    }
    if (this.pending.size === 0) this.firstAt = null;
    const readySet = new Set(ready);
    const active = this.seats.filter((s) => this.isActive(s, now) && readySet.has(s.pid!)).map((s) => s.pid!);
    const pending = new Map<PlayerId, PendingInput>();
    for (const [pid, p] of this.pending) pending.set(pid, { intent: p.intent, at: p.at, ready: readySet.has(pid) });
    const t = this.deps.timing;
    const wakes: number[] = [];
    for (const s of this.seats) {
      if (s.conn) {
        wakes.push(s.lastActiveAt + t.idleActiveMs);
        if (s.typingUntil !== null) wakes.push(s.typingUntil);
      } else if (s.awayAt !== null) wakes.push(s.awayAt);
    }
    if (this.clockDue !== null) wakes.push(this.clockDue);
    return {
      active,
      ready,
      pending,
      firstAt: this.firstAt,
      lastResolveAt: this.lastResolveAt,
      deadlineMs: t.deadlineMs || this.options.deadlineMs,
      travelMs: t.travelMs,
      countdownTurnMs: t.countdownTurnMs,
      countdown: !!state.area.exitCountdown,
      areaHoldUntil: this.hold?.until ?? null,
      anyConnected: this.anyConnected,
      wakes,
    };
  }

  /** one party turn with the ready players' pending inputs; the others' stay pending with a fresh deadline start */
  private resolve(advance: boolean): void {
    const state = this.state!;
    const ready = new Set(readyPlayers(state, { world: this.world.world }));
    const inputs: TurnInput[] = [];
    for (const [pid, p] of this.pending) {
      if (!ready.has(pid)) continue;
      inputs.push({ playerId: pid, actions: [p.action] });
      this.pending.delete(pid);
    }
    this.pushTurn(inputs, advance, true);
    const now = this.deps.scheduler.now();
    this.lastResolveAt = now;
    for (const p of this.pending.values()) p.at = now;
    this.firstAt = this.pending.size ? now : null;
    // a typing seat whose own turn action cleared its busy flag is busy again
    if (this.state && this.state.status === 'playing') {
      for (const s of this.seats) {
        if (s.typingUntil === null || !this.onMap(s.pid)) continue;
        const ps = this.state.players[s.pid];
        if (ps.busySince == null && !ps.down) this.busyEntry(s, true);
      }
    }
  }

  /**
   * Looks at the room now: typing expiry, the end of an area hold, the 2-minute rule, due turns;
   * then the roster and clock messages and the one timer. Called after every message and timer.
   */
  private evaluate(): void {
    if (this.closed || this.evaluating) return;
    this.evaluating = true;
    try {
      this.evaluateNow();
    } finally {
      this.evaluating = false;
    }
  }

  private evaluateNow(): void {
    const sch = this.deps.scheduler;
    const now = sch.now();
    if (!this.anyConnected) {
      // an empty room sleeps: no timers at all
      sch.cancel(this.timer);
      this.timer = null;
      return;
    }
    for (const s of this.seats) if (s.typingUntil !== null && s.typingUntil <= now) this.stopTyping(s, true);
    if (this.hold && this.hold.until <= now) this.hold = null;
    for (const s of this.seats.slice()) {
      if (s.conn || s.awayAt === null || s.awayAt > now) continue;
      if (this.phase === 'lobby') {
        this.removeSeat(s);
      } else if (this.phase === 'playing' && this.state && this.onMap(s.pid)) {
        // nobody leaves while every other party member is down, nor the last member: re-checked after every entry
        if (canLeave(this.state, s.pid)) {
          s.awayAt = null;
          this.push({ k: 'leave', pid: s.pid });
          this.log(`seat ${s.id} (${s.pid}) left the map`);
        }
      } else {
        s.awayAt = null;
      }
    }
    if (this.closeIfEmpty()) return;

    let decision: ClockDecision = { resolve: null, wakeAt: null };
    if (this.phase === 'playing' && this.state) {
      for (let i = 0; i < 50; i++) {
        decision = nextResolve(this.clockView(now), now);
        if (!decision.resolve || decision.resolve.at > now || this.phase !== 'playing') break;
        this.resolve(decision.resolve.advance);
        if (this.closed) return;
      }
      if (this.phase !== 'playing') decision = { resolve: null, wakeAt: nextResolve(this.clockView(now), now).wakeAt };
    } else {
      // lobby / ended: only the wakes (typing, away, idle)
      let wakeAt: number | null = null;
      for (const s of this.seats) {
        const w = s.conn ? [s.lastActiveAt + this.deps.timing.idleActiveMs, s.typingUntil ?? Infinity] : [s.awayAt ?? Infinity];
        for (const x of w) if (x > now && x !== Infinity && (wakeAt === null || x < wakeAt)) wakeAt = x;
      }
      decision = { resolve: null, wakeAt };
    }
    this.sendRoster(now);
    const clockAt = this.sendClock(now, decision);
    let at = decision.resolve ? decision.resolve.at : null;
    for (const w of [decision.wakeAt, clockAt]) if (w !== null && (at === null || w < at)) at = w;
    sch.cancel(this.timer);
    this.timer = null;
    if (at !== null) {
      this.timer = sch.setTimer(Math.max(at, now), () => {
        this.timer = null;
        this.guard(() => this.evaluate(), undefined);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Roster, clock, broadcast
  // -------------------------------------------------------------------------

  private presenceOf(s: Seat, now: number): SeatPresence {
    const ps = s.pid !== null && this.state ? this.state.players[s.pid] : undefined;
    if (ps?.left && this.phase === 'playing') return 'gone';
    if (!s.conn) return 'off';
    if (s.typingUntil !== null || ps?.pendingChoice) return 'busy';
    if (s.presence === 'menu') return 'menu';
    if (now - s.lastActiveAt >= this.deps.timing.idleActiveMs) return 'idle';
    return 'active';
  }

  roster(now = this.deps.scheduler.now()): RosterEntry[] {
    return this.seats.map((s) => {
      const p = this.presenceOf(s, now);
      if (p !== s.shown) {
        s.shown = p;
        s.since = now;
      }
      return { seat: s.id, pid: s.pid, name: s.name, colour: s.colour, host: this.host === s.id, connected: !!s.conn, presence: p, since: s.since };
    });
  }

  private sendRoster(now: number): void {
    const seats = this.roster(now);
    const key = JSON.stringify(seats.map(({ since: _since, ...rest }) => rest));
    if (key === this.lastRoster) return;
    this.lastRoster = key;
    this.broadcast({ t: 'roster', seats });
  }

  /** "2 of 3 acted" (throttled); returns when a throttled message is due, or null */
  private sendClock(now: number, d: ClockDecision): number | null {
    if (this.phase !== 'playing' || !this.state) return null;
    const view = this.clockView(now);
    const acted = [...view.pending.keys()];
    const waiting = view.active.filter((id) => !view.pending.has(id));
    const key = JSON.stringify([this.n, acted, waiting]);
    if (key === this.lastClock) {
      this.clockDue = null;
      return null;
    }
    if (now - this.lastClockAt < this.deps.timing.clockThrottleMs) {
      this.clockDue = this.lastClockAt + this.deps.timing.clockThrottleMs;
      return this.clockDue;
    }
    this.lastClock = key;
    this.lastClockAt = now;
    this.clockDue = null;
    this.broadcast({ t: 'clock', n: this.n, acted, waiting, ...(d.resolve && d.resolve.at > now ? { deadlineInMs: Math.round(d.resolve.at - now) } : {}) });
    return null;
  }

  private broadcast(msg: ServerMsg): void {
    for (const s of this.seats) if (s.conn) safeSend(s.conn, msg);
  }

  // -------------------------------------------------------------------------
  // Info, persistence, closing
  // -------------------------------------------------------------------------

  info(): RoomInfo {
    const w = this.world.world;
    return {
      code: this.code,
      world: { id: this.world.worldId, title: w.meta.title, genre: w.meta.genre, language: w.meta.language },
      players: this.seats.length,
      maxPlayers: this.options.maxPlayers,
      phase: this.phase,
      joinable: !this.closed && this.seats.length < this.options.maxPlayers,
    };
  }

  /** seat ids → their engine player (tests and logs) */
  seatList(): { seat: string; pid: PlayerId | null; connected: boolean; quit: boolean; name: string; colour: string }[] {
    return this.seats.map((s) => ({ seat: s.id, pid: s.pid, connected: !!s.conn, quit: s.quit, name: s.name, colour: s.colour }));
  }

  /** the last entries of this run (welcome after a reconnect) */
  recentEntries(): readonly LogEntry[] {
    return this.ring;
  }

  /** the server hash after `n` entries, when kept */
  hashAt(n: number): string | undefined {
    return this.hashes.get(n);
  }

  private roomFile(): RoomFile {
    return {
      format: 1,
      code: this.code,
      engineVersion: this.engineVersion,
      createdAt: this.createdAt,
      updatedAt: this.deps.scheduler.now(),
      options: { ...this.options },
      phase: this.phase,
      run: this.run,
      seed: this.seed,
      host: this.host,
      nextSeat: this.nextSeat,
      seats: this.seats.map((s) => this.seatRecord(s)),
      snapshot: this.stored.snapshot,
      hooks: this.stored.hooks,
      chat: this.chat.slice(),
    };
  }

  /** rewrites the room file (keeping the stored snapshot) */
  private persistRoom(truncate: boolean): void {
    this.deps.store?.writeRoom(this.roomFile(), truncate);
  }

  /** a snapshot of the state now: the room file is rewritten and the log truncated */
  snapshot(): void {
    if (!this.state) return;
    this.stored = { snapshot: { n: this.n, state: serialize(this.state) }, hooks: { ...this.tracker, bossesSeen: [...this.tracker.bossesSeen] } };
    this.persistRoom(true);
  }

  /** every seat has sent `leave` or its character is gone (or no seat is left): the room closes */
  private closeIfEmpty(): boolean {
    if (this.closed) return true;
    const gone = (s: Seat) => s.quit || (this.phase === 'playing' && s.pid !== null && !!this.state?.players[s.pid]?.left);
    if (this.seats.every((s) => !s.conn && gone(s))) {
      this.close('empty');
      return true;
    }
    return false;
  }

  /** closes the room: every connection gets `closed` and close 4010; the manager removes the files */
  close(reason: ClosedReason, message = closedMessage(reason)): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.scheduler.cancel(this.timer);
    this.timer = null;
    for (const s of this.seats) {
      if (!s.conn) continue;
      safeSend(s.conn, { t: 'closed', reason, message });
      safeClose(s.conn, CLOSE.closed, reason);
      s.conn = null;
    }
    this.log(`closed (${reason})`);
    this.deps.onClose?.(this, reason);
  }

  /** graceful shutdown: a snapshot (or the room file), then `bye` to every connection */
  shutdown(): void {
    if (this.closed) return;
    this.deps.scheduler.cancel(this.timer);
    this.timer = null;
    try {
      if (this.state) this.snapshot();
      else this.persistRoom(false);
    } catch (e) {
      this.log(`snapshot at shutdown failed: ${String(e)}`);
    }
    for (const s of this.seats) {
      if (!s.conn) continue;
      safeSend(s.conn, { t: 'bye', reason: 'restart' });
      safeClose(s.conn, 1012, 'restart');
      s.conn = null;
    }
  }

  /** runs `fn`; an exception (an engine bug, a full disk) closes this room only */
  private guard<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      this.log(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      this.close('error');
      return fallback;
    }
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(`[room ${this.code}] ${line}`);
  }
}

export function refused(code: RefusedCode, message: string, reason?: ClosedReason): Refused {
  return { t: 'refused', code, message, ...(reason ? { reason } : {}) };
}

function closedMessage(reason: ClosedReason): string {
  switch (reason) {
    case 'server_updated':
      return 'The server was updated; this room is closed.';
    case 'idle':
      return 'This room was idle for two hours and is closed.';
    case 'empty':
      return 'Everyone has left; this room is closed.';
    case 'error':
      return 'This room hit an error and is closed.';
  }
}

function safeSend(conn: Conn, msg: ServerMsg): void {
  try {
    conn.send(msg);
  } catch {
    // a dead socket: its close handler takes the seat off
  }
}

function safeClose(conn: Conn, code: number, reason: string): void {
  try {
    conn.close(code, reason);
  } catch {
    // already closed
  }
}
