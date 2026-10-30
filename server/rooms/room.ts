/**
 * One room (MP2 design §3–§6): seats and roster, phases (lobby → playing → ended → play again),
 * the engine state moved only by log entries (src/net/log.ts applyEntry), the turn clock
 * (clock.ts), chat, typing, GM entries, hash checks and the 2-minute rule.
 *
 * The game master (MP4 design §1): a RoomGm per run (gm.ts) answers each moment for one target
 * player, synchronously ('offline' as MP2, 'recorded' for a demo world without a provider) or later
 * ('ai'); every answer is checked again against the current state (Room.gmAnswer) and becomes a gm
 * entry, so clients and a restart replay apply it like any other entry and nothing ever re-asks.
 * In 'ai' rooms a player's conversation turns are also voiced (words only, the cosmetic `npc`
 * message, never an entry: Room.voiceTurns).
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
import { BUSY_MAX_TURNS } from '../../src/engine/ai';
import { FREE_ACTIONS } from '../../src/engine/party';
import type { GameState, PlayerAction, PlayerId, TurnInput, TurnOutcome } from '../../src/engine/types';
import { parseWorld } from '../../src/schema';
import type { WorldSpec } from '../../src/schema/world';
import { cloneTracker, gmHooksFor, newHookTracker, OfflineGmDirector, sanitizeResponse, type GmContext, type GmHookEvent, type GmTranslate, type HookTracker, type OfflineGmKey } from '../../src/gm/offline';
import { perspective } from '../../src/gm/perspective';
import { recheckGmActions, recheckOfferOption } from '../../src/gm/recheck';
import { chatQuotes } from '../../src/gm/chat';
import { voiceMoment } from '../../src/gm/voice';
import type { DialogueLine } from '../../src/llm/prompts/dialogue';
import { applyHelpCeiling, isHelpfulAction, isWordAction, threatensPlayer } from '../../src/llm/gm-checks';
import { helpCeiling } from '../../src/llm/prompts/gm';
import { worldKeyOf } from '../../src/llm/recording-keys';
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
import { hostileInView, nextResolve, type ClockDecision, type ClockView, type PendingInput } from './clock';
import type { RoomTiming, Scheduler, TimerId } from './timing';
import { linesToReplay, type LoadedRoom, type LogLine, type RoomFile, type RoomStore, type SeatRecord, type WorldFile } from './store';
import type { DemoWorlds } from './worlds';
import { addressesGm, gmAnswerStale, roomGmMode, RoomGm, type GmAnswer, type GmServer, type RoomGmMode } from './gm';

/** rooms create their runs with this exit countdown (≈ 10 s at countdownTurnMs; a constant, not derived from the timing) */
export const EXIT_COUNTDOWN_TURNS = 10;
/** entries between snapshots */
export const SNAPSHOT_EVERY = 100;
/** entries kept for welcome after a reconnect */
export const RING_SIZE = 512;
/** server hashes kept (one per LIMITS.hashEvery entries) */
export const HASH_RING = 64;
/** log lines (seat records, chat) appended since the last room file rewrite above which it is rewritten (lobby, ended, or chat between snapshots) */
export const LOG_COMPACT_LINES = 200;
/** a seat gets at most one desync snapshot this often (a wrong hash report is otherwise a cheap amplifier) */
export const DESYNC_SNAPSHOT_MS = 5000;
/** 'illegal' outcomes a minute per player above which the room logs a line (design §9) */
export const ILLEGAL_LOG_PER_MIN = 20;
/** the GM's weirdness in rooms (the offline director does not read it) */
const ROOM_WEIRDNESS = 0.5;
/** the chat hook (MP4 design §3.2): at most one per room this often for chatter that does not address the GM */
export const CHAT_HOOK_ROOM_MS = 20_000;
/** a seat addressing the GM fires the chat hook at most this often (MP5: was a minute, a follow-up was ignored) */
export const CHAT_ADDRESS_SEAT_MS = 20_000;
/** a line addressing the GM: at most one chat hook per room this often; a line inside the window is owed an answer, not dropped */
export const CHAT_ADDRESS_ROOM_MS = 5000;
/** an owed answer (a line that addressed the GM while it was busy) is given up after this long */
export const CHAT_OWED_MAX_MS = 60_000;
/** or this many new lines since the GM's last chat answer, and this long since the last chat hook */
export const CHAT_HOOK_LINES = 4;
export const CHAT_HOOK_QUIET_MS = 60_000;

/** one connection as the room sees it */
export interface Conn {
  send(msg: ServerMsg): void;
  /** the same message already serialized (a broadcast serializes once for every seat, MP5); optional */
  sendText?(text: string): void;
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
  /** the GM pieces every room shares (gm.ts); absent: every room offline */
  gm?: GmServer;
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
  /** the turn typing started (its busy is re-appended after the typist's own action only within BUSY_MAX_TURNS of it) */
  typingTurn: number | null;
  /** typing set the busy flag (the seat was not busy already from a dialogue, a trade or a menu): only then does stopping it clear busy */
  typingBusy: boolean;
  /** the lobby's ready toggle (MP3; reset when a run starts) */
  ready: boolean;
  lastChatAt: number;
  /** the last chat line of this seat that addressed the GM and fired the chat hook */
  lastGmCallAt: number;
  lastDesyncAt: number;
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
  /** this run's game master (null in the lobby and before a loaded room's run has one) */
  private gm: RoomGm | null = null;
  /** party-wide moments go to the member least recently targeted (pid → sequence number) */
  private targeted = new Map<PlayerId, number>();
  private targetSeq = 0;
  /** wall-clock time of the GM's last answer to a chat hook, and of the last chat hook */
  private lastChatAnswerAt: number | undefined = undefined;
  private lastChatHookAt = -Infinity;
  /**
   * MP5: a line addressed the GM while a chat request was queued or running, inside the room's
   * window or during the area hold: one chat hook is owed (fired when that ends, quoting every line
   * since the last answer). `pid`: the newest asker on the map.
   */
  private chatOwed: { at: number; pid: PlayerId | null } | null = null;
  /** set while askGm runs: a synchronous answer is pushed in its caller's guard */
  private askingGm = false;
  /**
   * the NPC voice per player (design §4.3): the open conversation's NPC, the entry of its last turn,
   * the lines so far and the NPC's latest line (voiced, else the engine's). Not persisted.
   */
  private voiceHistory = new Map<PlayerId, { npcId: string; n: number; lines: DialogueLine[]; last: string }>();
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
  /** since when no seat is connected (null while one is): the manager closes a lobby empty for timing.awayMs */
  emptySince: number | null;
  /** log lines appended since the room file was last rewritten */
  private logLines = 0;
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
    this.emptySince = createdAt;
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
    // the chat bookkeeping is not stored: every restored line counts as seen (the GM may have answered
    // it before the kill) and the room's chat throttle starts again at the restart, so nothing re-asks
    if (room.chat.length) room.lastChatAnswerAt = Math.max(...room.chat.map((c) => c.at));
    room.lastChatHookAt = now;
    room.stored = { snapshot: f.snapshot, hooks: f.hooks };
    if (f.snapshot) {
      let state = deserialize(pw.world, f.snapshot.state);
      room.n = f.snapshot.n;
      // defaults merged under the file's fields: an older room file loads without the new ones
      room.tracker = f.hooks ? cloneTracker({ ...newHookTracker(state.turn), ...f.hooks }) : newHookTracker(state.turn);
      if (room.n % LIMITS.hashEvery === 0) room.hashes.set(room.n, hashState(state));
      for (const raw of entries) {
        const e = LogEntrySchema.parse(raw);
        const r = applyEntry(pw.world, state, e);
        if (e.k === 'turn') gmHooksFor(pw.world, state, r.state, r.events, room.tracker);
        const prev = state;
        state = r.state;
        room.record(e, prev, state);
      }
      room.state = state;
      if (room.phase === 'playing' && state.status !== 'playing') room.phase = 'ended';
      // (the director is never asked while loading: a request in flight at the kill is simply lost)
      if (room.phase === 'playing') room.gm = room.makeGm();
    } else if (room.phase !== 'lobby') {
      throw new Error(`phase ${room.phase} without a snapshot`);
    }
    room.lastResolveAt = now;
    room.lastActivityAt = now;
    room.emptySince = now;
    room.logLines = loaded.lines.length;
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
      typingTurn: null,
      typingBusy: false,
      ready: false,
      lastChatAt: -Infinity,
      lastGmCallAt: -Infinity,
      lastDesyncAt: -Infinity,
      shown: null,
      since: now,
    };
  }

  /** an applied entry: n, the ring, the hash cadence and the GM's help count (on the state before a gm entry, §1.5) */
  private record(e: LogEntry, before: GameState, state: GameState): void {
    if (e.k === 'gm') this.countHelp(e, before);
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
    this.append({ seat: this.seatRecord(s, removed) });
  }

  /**
   * Appends a log line. Seat records and chat lines also come in the lobby and the ended phase, where
   * no snapshot truncates the log: after LOG_COMPACT_LINES lines the room file (seats, chat, the
   * stored snapshot, or a fresh one while there is a state) is rewritten and the log emptied.
   */
  private append(line: LogLine): void {
    const store = this.deps.store;
    if (!store) return;
    store.append(this.code, line);
    // (entries snapshot on their own cadence, after the GM tracker has seen them: settle)
    if (++this.logLines < LOG_COMPACT_LINES || 'e' in line) return;
    if (this.state) this.snapshot();
    else this.persistRoom(true);
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
      typingTurn: null,
      typingBusy: false,
      ready: false,
      lastChatAt: -Infinity,
      lastGmCallAt: -Infinity,
      lastDesyncAt: -Infinity,
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
    }
    const fresh = !h.token;
    return this.guard(() => {
      const s = seat!;
      // (inside the guard: a full disk closes this room, never the process)
      if (fresh) this.persistSeat(s);
      // (before a replaced socket is dropped: a reconnect over a half-open socket wakes nothing, MP5)
      const wasEmpty = !this.anyConnected;
      // a second socket with the same token replaces the first (a new tab)
      if (s.conn) {
        const old = s.conn;
        s.conn = null;
        safeClose(old, CLOSE.replaced, 'replaced');
      }
      // the 2-minute timer is cancelled before anything else
      s.awayAt = null;
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
        // (a pid without a player: a crash between the seat record and its join entry)
        if (s.pid === null || !this.state.players[s.pid]) {
          const pid = nextPid(this.state);
          s.pid = pid;
          // the seat record before the entry, so a replay never sees the join without its seat
          this.persistSeat(s);
          changed = false;
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
      this.emptySince = null;
      this.ensureHost();
      conn.send(this.welcome(s, token, h));
      // (typing is not in the roster: the newcomer gets the typing frames of those typing now)
      for (const o of this.seats) if (o !== s && o.conn && o.typingUntil !== null) conn.send({ t: 'typing', seat: o.id, on: true });
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
    this.dropFromHold(s);
    if (this.phase === 'playing' && this.onMap(s.pid)) this.push({ k: 'away', pid: s.pid });
    if (!this.anyConnected) this.emptySince = now;
    this.ensureHost();
  }

  /** a seat that no longer holds the area hold (applied, or gone); when none is left the hold ends now */
  private dropFromHold(s: Seat): void {
    const hold = this.hold;
    if (!hold) return;
    hold.waitFor.delete(s.id);
    if (hold.waitFor.size) return;
    this.hold = null;
    // a first action taken during the hold starts its deadline when the hold actually ends
    const now = this.deps.scheduler.now();
    if (this.firstAt !== null && this.firstAt > now) this.firstAt = now;
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
          this.lobbyActive(s, now);
          if (msg.on) this.startTyping(s);
          else this.stopTyping(s, true);
          break;
        case 'chat':
          this.lobbyActive(s, now);
          this.say(s, msg.text);
          break;
        case 'hash':
          this.checkHash(s, msg.n, msg.h);
          break;
        case 'applied':
          if (this.hold && msg.n >= this.hold.n) this.dropFromHold(s);
          break;
        case 'start':
          this.start(s, msg.demo);
          break;
        case 'options':
          this.setOptions(s, msg);
          break;
        case 'ready':
          this.lobbyActive(s, now);
          this.setReady(s, msg.on);
          break;
        case 'profile':
          this.setProfile(s, msg.name, msg.colour);
          break;
        case 'world':
          this.pickWorld(s, msg.demo);
          break;
        case 'ping':
          this.ping(s, msg);
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

  /**
   * chat, typing and Ready count as activity in the lobby and after a run (MP5: a chatting player read
   * as idle 10 s after joining); in a run only inputs and presence do, so the clock never waits on a
   * player who only chats
   */
  private lobbyActive(s: Seat, now: number): void {
    if (this.phase !== 'playing') s.lastActiveAt = now;
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
      // the client's own busy (a trade, a menu) is not typing's to clear; when the client clears it while the seat types, typing holds it
      if (s.typingUntil !== null && m.busy === true) s.typingBusy = false;
      else if (s.typingUntil !== null) this.typingHoldsBusy(s);
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
    s.typingTurn = this.state?.turn ?? null;
    this.broadcast({ t: 'typing', seat: s.id, on: true });
    // a seat already busy (a dialogue, a trade, a menu) keeps that busy: typing does not take it over
    s.typingBusy = false;
    this.typingHoldsBusy(s);
  }

  private stopTyping(s: Seat, entry: boolean): void {
    if (s.typingUntil === null) return;
    const own = s.typingBusy;
    s.typingUntil = null;
    s.typingTurn = null;
    s.typingBusy = false;
    this.broadcast({ t: 'typing', seat: s.id, on: false });
    // (only the busy typing set: stopping does not end a dialogue's or a trade's safety)
    if (entry && own) this.busyEntry(s, false);
  }

  /** a typing seat that is not busy (and within BUSY_MAX_TURNS of the typing start) becomes busy, and that busy is typing's */
  private typingHoldsBusy(s: Seat): void {
    if (s.typingUntil === null || this.phase !== 'playing' || !this.state || this.state.status !== 'playing' || !this.onMap(s.pid)) return;
    const ps = this.state.players[s.pid];
    if (ps.busySince != null || ps.down) return;
    if (s.typingTurn !== null && this.state.turn - s.typingTurn >= BUSY_MAX_TURNS) return;
    this.busyEntry(s, true);
    if (this.state.players[s.pid]?.busySince != null) s.typingBusy = true;
  }

  private busyEntry(s: Seat, busy: boolean): void {
    if (this.phase === 'playing' && this.onMap(s.pid)) this.pushTurn([{ playerId: s.pid, busy }], false, false);
  }

  private say(s: Seat, text: string): void {
    const clean = cleanChat(text);
    if (clean === null) return this.error(s, 'chat_long', `at most ${LIMITS.chatMax} characters`);
    const now = this.deps.scheduler.now();
    if (now - s.lastChatAt < 1000 / LIMITS.rates.chat.perSec) return this.error(s, 'chat_rate', 'one message a second');
    this.addLine(s, { text: clean });
    this.stopTyping(s, true);
  }

  /** a ping (MP3): a chat line with no text at a tile of the current area; the same 1/s as chat */
  private ping(s: Seat, m: Extract<ClientMsg, { t: 'ping' }>): void {
    const state = this.state;
    if (this.phase !== 'playing' || !state || !this.onMap(s.pid)) return this.error(s, 'bad_phase', 'not playing');
    if (m.x >= state.area.map.width || m.y >= state.area.map.height) return this.error(s, 'invalid', 'not on the map');
    if (this.deps.scheduler.now() - s.lastChatAt < 1000 / LIMITS.rates.chat.perSec) return this.error(s, 'chat_rate', 'one message a second');
    this.addLine(s, { text: '', ping: { kind: m.kind, x: m.x, y: m.y, area: state.area.index } });
  }

  /** a chat line from `s`: kept (the last LIMITS.chatHistory), logged and sent to everyone */
  private addLine(s: Seat, body: Pick<ChatLine, 'text' | 'ping'>): void {
    const now = this.deps.scheduler.now();
    s.lastChatAt = now;
    this.lastActivityAt = now;
    const line: ChatLine = { id: this.nextChatId++, seat: s.id, name: s.name, colour: s.colour, text: body.text, at: now, ...(body.ping ? { ping: body.ping } : {}) };
    this.chat.push(line);
    if (this.chat.length > LIMITS.chatHistory) this.chat.shift();
    this.append({ chat: line });
    this.broadcast({ t: 'chat', line });
    if (!body.ping && body.text) this.chatHook(s, body.text, now);
  }

  /**
   * The chat hook (MP4 design §3.2, AI rooms only; wall clock, never replayed: only its answer is):
   * a line that addresses the GM (at most once per seat every CHAT_ADDRESS_SEAT_MS, and once per room
   * every CHAT_ADDRESS_ROOM_MS), or CHAT_HOOK_LINES new lines since the GM's last chat answer and a
   * quiet minute (at most one per CHAT_HOOK_ROOM_MS). One chat request at a time: a line that
   * addresses the GM while one is queued or running, inside the room's window or during the
   * area-entry hold is owed an answer (MP5: never dropped), fired by flushChatOwed.
   */
  private chatHook(s: Seat, text: string, now: number): void {
    const gm = this.gm;
    const state = this.state;
    if (!gm || this.phase !== 'playing' || !state || state.status !== 'playing') return;
    if (gm.current() !== 'ai') return;
    const addressed = now - s.lastGmCallAt >= CHAT_ADDRESS_SEAT_MS && addressesGm(text, this.world.world.gm.persona);
    if (addressed) {
      s.lastGmCallAt = now;
      this.chatOwed = { at: this.chatOwed?.at ?? now, pid: this.onMap(s.pid) ? s.pid : (this.chatOwed?.pid ?? null) };
      this.flushChatOwed(now);
      return;
    }
    if (this.hold || this.chatOwed || this.chatPending(gm)) return;
    if (now - this.lastChatHookAt < CHAT_HOOK_ROOM_MS) return;
    const fresh = chatQuotes(this.chat, now, this.lastChatAnswerAt).filter((q) => q.new).length;
    if (fresh < CHAT_HOOK_LINES || now - this.lastChatHookAt < CHAT_HOOK_QUIET_MS) return;
    this.fireChatHook(state, null, now);
  }

  private chatPending(gm: RoomGm): boolean {
    return gm.pendingHooks().some((h) => h.hook === 'chat');
  }

  /** an owed chat answer is asked once no chat request is queued or running, the hold is over and the room's window is open */
  private flushChatOwed(now: number): void {
    const owed = this.chatOwed;
    const gm = this.gm;
    const state = this.state;
    if (!owed) return;
    if (!gm || this.phase !== 'playing' || !state || state.status !== 'playing' || now - owed.at > CHAT_OWED_MAX_MS) {
      this.chatOwed = null;
      return;
    }
    if (this.hold || this.chatPending(gm) || now - this.lastChatHookAt < CHAT_ADDRESS_ROOM_MS) return;
    if (gm.current() !== 'ai') {
      this.chatOwed = null;
      this.log('gm chat line not answered (the AI GM is on its fallback)');
      return;
    }
    this.chatOwed = null;
    this.fireChatHook(state, owed.pid && this.onMap(owed.pid) ? owed.pid : null, now);
  }

  private fireChatHook(state: GameState, subject: PlayerId | null, now: number): void {
    this.lastChatHookAt = now;
    this.askGm([{ hook: 'chat', area: state.area.index, turn: state.turn, ...(subject ? { detail: { playerId: subject } } : {}) }]);
  }

  /**
   * An 'ai' request left the GM's queue (answered, silent, failed, dropped): a finished chat request
   * marks the lines it was shown as seen (those up to its ask, not those said while it ran), and an
   * owed chat answer may go now.
   */
  private gmSettled(hook: GmHookEvent, askedAt: number): void {
    if (hook.hook === 'chat') this.lastChatAnswerAt = Math.max(this.lastChatAnswerAt ?? -Infinity, askedAt);
    if (this.chatOwed && !this.askingGm && !this.closed) this.guard(() => this.evaluate(), undefined);
  }

  private checkHash(s: Seat, n: number, h: string): void {
    const expected = this.hashes.get(n);
    if (!this.state || expected === undefined || expected === h) return;
    const now = this.deps.scheduler.now();
    if (now - s.lastDesyncAt < DESYNC_SNAPSHOT_MS) return;
    s.lastDesyncAt = now;
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
    for (const s of this.seats.slice()) {
      if (s.conn) continue;
      // a seat that sent `leave` gets no character; after a run, nor one off for 2 minutes
      if (s.quit || (this.phase === 'ended' && !(s.offSince !== null && now - s.offSince < this.deps.timing.awayMs))) this.removeSeat(s);
    }
    // from the lobby the run always carries the world: an upload there replaced it without telling anyone
    const fromLobby = this.phase === 'lobby';
    const worldChanged = world.worldId !== this.world.worldId;
    if (worldChanged) {
      const old = this.world;
      this.world = world;
      this.director = new OfflineGmDirector({ t: gmTranslate(world.world.meta.language) });
      registerWorld(world.world);
      this.deps.store?.writeWorld(this.code, { format: 1, worldId: world.worldId, world: world.world, source: world.source });
      this.deps.releaseWorld?.(old.worldId);
    }
    this.dropNextWorld();
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
      s.ready = false;
      this.persistSeat(s);
    });
    this.state = state;
    this.tracker = newHookTracker(state.turn);
    this.targeted.clear();
    this.voiceHistory.clear();
    this.lastChatAnswerAt = undefined;
    this.lastChatHookAt = -Infinity;
    this.chatOwed = null;
    // the old run's GM is gone (its late answers too); the intro is asked on the new one
    this.gm?.dispose();
    this.gm = this.makeGm();
    this.phase = 'playing';
    this.lastResolveAt = now;
    this.hashes.set(0, hashState(state));
    this.snapshot();
    // the roster with the new player ids first, so a client knows its pid when the run arrives (MP3:
    // the browser builds its session on `run`, before the GM's intro entry)
    this.sendRoster(now);
    this.broadcast({ t: 'run', run: this.run, ...(worldChanged || fromLobby ? { world: world.world } : {}), worldId: world.worldId, snapshot: { n: 0, state: serialize(state) } });
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
    // (the run's difficulty is fixed once it is made)
    if (m.difficulty !== undefined && m.difficulty !== this.options.difficulty && this.phase === 'playing') return this.error(s, 'bad_phase', 'the difficulty changes between runs');
    const next: RoomOptions = {
      ...this.options,
      ...(m.deadlineMs !== undefined ? { deadlineMs: m.deadlineMs } : {}),
      ...(m.maxPlayers !== undefined ? { maxPlayers: m.maxPlayers } : {}),
      ...(m.difficulty !== undefined ? { difficulty: m.difficulty } : {}),
    };
    if (next.deadlineMs === this.options.deadlineMs && next.maxPlayers === this.options.maxPlayers && next.difficulty === this.options.difficulty) return;
    this.options = next;
    // (a synchronous fsync'ed rewrite: the options bucket, LIMITS.rates.options, keeps these rare)
    this.persistRoom(false);
    this.broadcastRoom();
  }

  /** the ready toggle (MP3): lobby and ended phases */
  private setReady(s: Seat, on: boolean): void {
    if (this.phase === 'playing') return this.error(s, 'bad_phase', 'the run is on');
    s.ready = on;
  }

  /** a new name and colour (MP3), made unique as in hello: lobby and ended phases (the character keeps its name for the run) */
  private setProfile(s: Seat, name: string, colour: string): void {
    if (this.phase === 'playing') return this.error(s, 'bad_phase', 'the run is on');
    const n = this.uniqueName(name, s);
    const c = this.uniqueColour(colour, s);
    if (n === s.name && c === s.colour) return;
    s.name = n;
    s.colour = c;
    this.persistSeat(s);
  }

  /** the host picks a demo world (MP3): the lobby's world at once, or the next run's after a run */
  private pickWorld(s: Seat, demo: string): void {
    if (this.host !== s.id) return this.error(s, 'not_host', 'only the host can change the world');
    if (this.phase === 'playing') return this.error(s, 'bad_phase', 'the run is on');
    const d = this.deps.demos.get(demo);
    if (!d) return this.error(s, 'invalid', `no demo world "${demo}"`);
    this.setWorld({ world: d.world, worldId: d.worldId, source: { demo: d.id } });
  }

  /** everyone gets the room's info and options again (a world or options change) */
  private broadcastRoom(): void {
    this.broadcast({ t: 'room', room: this.info(), options: { ...this.options } });
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
    this.setWorld(world);
    return 'ok';
  }

  /** the world of the next run (lobby: the room's world at once; ended: staged for the next start); everyone gets `room` */
  private setWorld(world: RoomWorld): void {
    registerWorld(world.world);
    if (this.phase === 'ended') {
      if (this.nextWorld?.worldId === world.worldId) return;
      this.dropNextWorld();
      // (the world just played again: nothing to stage)
      if (world.worldId !== this.world.worldId) this.nextWorld = world;
      return this.broadcastRoom();
    }
    const old = this.world;
    if (old.worldId === world.worldId && JSON.stringify(old.source) === JSON.stringify(world.source)) return;
    this.world = world;
    this.director = new OfflineGmDirector({ t: gmTranslate(world.world.meta.language) });
    this.deps.store?.writeWorld(this.code, { format: 1, worldId: world.worldId, world: world.world, source: world.source });
    if (old.worldId !== world.worldId) this.deps.releaseWorld?.(old.worldId);
    this.broadcastRoom();
  }

  /** the world staged for the next start, if any */
  get nextWorldId(): string | null {
    return this.nextWorld?.worldId ?? null;
  }

  /** forgets the staged world; the manager unregisters it when nobody else plays it */
  private dropNextWorld(): void {
    const staged = this.nextWorld;
    this.nextWorld = null;
    if (staged && staged.worldId !== this.world.worldId) this.deps.releaseWorld?.(staged.worldId);
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
    this.record(e, before, r.state);
    this.append({ e });
    this.broadcast({ t: 'entries', run: this.run, es: [e] });
    if (e.k === 'turn') this.countIllegal(r.outcomes);
    let hooks: GmHookEvent[] = [];
    if (e.k === 'turn') hooks = gmHooksFor(this.world.world, before, r.state, r.events, this.tracker);
    this.settle(before, r.state);
    if (hooks.length) this.askGm(hooks);
    if (e.k === 'turn') this.voiceTurns(e, before, r);
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
    const asked = inputs.length;
    inputs = this.refusePassedOffers(before, inputs);
    if (asked && !inputs.length && !advance) return false;
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

  /**
   * A chosen GM offer option was checked when the offer was made but runs now (MP4 design §1.4):
   * when the recheck on the exact state this turn applies to would trim it, the choice (and what the
   * input sent after it) is refused with `offer_gone`; the player can still pick another option.
   */
  private refusePassedOffers(state: GameState, inputs: TurnInput[]): TurnInput[] {
    return inputs.flatMap((inp) => {
      const pc = state.players[inp.playerId]?.pendingChoice;
      const i = pc?.kind === 'gm_offer' && inp.actions ? inp.actions.findIndex((a) => a.type === 'choose_option') : -1;
      if (i < 0) return [inp];
      const a = inp.actions![i] as Extract<PlayerAction, { type: 'choose_option' }>;
      if (!recheckOfferOption(this.world.world, state, a.index, inp.playerId).dropped.length) return [inp];
      const seat = this.seats.find((x) => x.pid === inp.playerId);
      if (seat) this.error(seat, 'offer_gone', 'that offer has passed');
      const actions = inp.actions!.slice(0, i);
      const { actions: _all, ...rest } = inp;
      if (!actions.length) return rest.busy !== undefined ? [rest] : [];
      return [{ ...rest, actions }];
    });
  }

  /** the room's GM for a new run (or a loaded one) */
  private makeGm(): RoomGm {
    const w = this.world;
    const demo = 'demo' in w.source ? w.source.demo : null;
    return new RoomGm({
      mode: roomGmMode(this.deps.gm?.config, w.source),
      server: this.deps.gm ?? null,
      room: this.code,
      run: this.run,
      world: w.world,
      demo,
      worldKey: demo ?? worldKeyOf(w.world),
      // the count lives in the tracker (updated per gm entry); the push-time check is the real guard
      ledger: { get: (s) => this.helpUsed(s), add: () => {} },
      scheduler: this.deps.scheduler,
      offline: this.director,
      onAnswer: (a) => (this.askingGm ? this.gmAnswer(a) : this.guard(() => (this.gmAnswer(a), this.evaluate()), undefined)),
      onSettled: (hook, askedAt) => this.gmSettled(hook, askedAt),
      log: (l) => this.log(l),
    });
  }

  /** this run's GM mode now ('ai' rooms on their fallback while the breaker is open or a cap reached) */
  gmMode(): RoomGmMode {
    return this.gm?.current() ?? roomGmMode(this.deps.gm?.config, this.world.source);
  }

  /** resolves when the room's GM has nothing queued or in flight (tests) */
  gmIdle(): Promise<void> {
    return this.gm?.idle() ?? Promise.resolve();
  }

  /** helpful GM actions so far in `state`'s area (the tracker's count, §1.5) */
  private helpUsed(state: GameState): number {
    const h = this.tracker.help;
    return h && h.area === state.area.index ? h.used : 0;
  }

  /** a gm entry's helpful actions, judged on the state before it from its target's perspective */
  private countHelp(e: Extract<LogEntry, { k: 'gm' }>, before: GameState): void {
    const area = before.area.index;
    const pid = e.pid !== undefined && before.party.includes(e.pid) ? e.pid : before.party[0];
    const view = pid ? perspective(before, pid) : before;
    const n = e.actions.filter((a) => isHelpfulAction(this.world.world, a, view)).length;
    const h = this.tracker.help;
    if (!n && (!h || h.area === area)) return;
    this.tracker.help = { area, used: (h && h.area === area ? h.used : 0) + n };
  }

  /**
   * Each moment is answered for one target player (MP4 design §1.4): offline exactly as MP2 (the
   * lead, no pid); otherwise the target is picked first and the context is built from its perspective
   * (with the chat in AI rooms); 'recorded' answers at once, 'ai' later (Room.gmAnswer).
   */
  private askGm(hooks: GmHookEvent[]): void {
    for (const h of hooks) {
      const state = this.state;
      if (!state || state.status !== 'playing') return;
      const mode = this.gm ? this.gm.current() : 'offline';
      if (mode === 'offline') {
        this.askOffline(h, state);
        continue;
      }
      // (the run has ended: the end screen has the world's endings)
      if (h.hook === 'death' || h.hook === 'victory') continue;
      const pid = this.targetFor(h, state);
      const ctx = this.gmContext(state, pid, mode === 'ai');
      this.askingGm = true;
      try {
        this.gm!.ask(h, pid, ctx, mode);
      } finally {
        this.askingGm = false;
      }
    }
  }

  /** MP2's canned GM: the offline director for the lead; a non-empty answer becomes a gm entry */
  private askOffline(h: GmHookEvent, state: GameState): void {
    const res = this.director.respondSync({
      ...h,
      ctx: { world: this.world.world, state, difficulty: state.difficulty ?? this.options.difficulty, weirdness: ROOM_WEIRDNESS, recentLog: state.log.slice(-12), areaEnteredTurn: this.tracker.areaEnteredTurn },
    });
    const clean = res ? sanitizeResponse(res) : null;
    if (!clean) return;
    const body = { k: 'gm' as const, hook: h.hook, actions: clean.actions };
    // (clients validate entries with the same schema: an entry they would drop is never sent)
    if (!LogEntrySchema.safeParse({ ...body, n: 0, run: 0 }).success) {
      this.log(`gm answer to ${h.hook} dropped (does not match the protocol)`);
      return;
    }
    this.push(body);
  }

  /**
   * The player a moment is for: its subject when on the map; else (party-wide moments) the member
   * least recently targeted who is on the map and not down, preferring one without an open choice
   * (an offer or a trade for a member with a choice open would be refused); else the lead.
   */
  private targetFor(h: GmHookEvent, state: GameState): PlayerId {
    const subject = h.detail?.playerId;
    let pid: PlayerId | undefined = subject !== undefined && state.party.includes(subject) ? subject : undefined;
    if (!pid) {
      const cands = state.party.filter((id) => !state.players[id]?.down && !state.players[id]?.left);
      const busy = (id: PlayerId) => (state.players[id]?.pendingChoice ? 1 : 0);
      cands.sort((a, b) => busy(a) - busy(b) || (this.targeted.get(a) ?? 0) - (this.targeted.get(b) ?? 0));
      pid = cands[0] ?? state.party[0]!;
    }
    this.targeted.set(pid, ++this.targetSeq);
    return pid;
  }

  /** the GM's context for `pid`: the state from its perspective (a snapshot), the recent log and, for the AI GM, the chat */
  private gmContext(state: GameState, pid: PlayerId, withChat: boolean): GmContext {
    const chat = withChat ? chatQuotes(this.chat, this.deps.scheduler.now(), this.lastChatAnswerAt) : [];
    return {
      world: this.world.world,
      state: perspective(state, pid),
      difficulty: state.difficulty ?? this.options.difficulty,
      weirdness: ROOM_WEIRDNESS,
      recentLog: state.log.slice(-12),
      areaEnteredTurn: this.tracker.areaEnteredTurn,
      ...(chat.length ? { chat } : {}),
    };
  }

  /**
   * A GM answer becomes a gm entry (MP4 design §1.4), checked against the CURRENT state: dropped when
   * the room moved on (closed, not playing, another run or area) or the moment passed (wall clock);
   * a target no longer on the map keeps only words (for the lead); a target with a choice open loses
   * offers and trades; a chat answer keeps only words; a target who is down loses harm and threats; then the stale-fiat recheck and the help
   * ceiling against the tracker's count (two answers in flight both saw the same count). A no-op is
   * not appended.
   */
  private gmAnswer(a: GmAnswer): void {
    const state = this.state;
    const now = this.deps.scheduler.now();
    if (this.closed || this.phase !== 'playing' || !state || state.status !== 'playing') return;
    if (a.run !== this.run || a.area !== state.area.index) return this.log(`gm answer to ${a.hook.hook} dropped (asked in run ${a.run} area ${a.area})`);
    if (gmAnswerStale(a.hook.hook, a.askedAt, now)) return this.log(`gm answer to ${a.hook.hook} dropped (${Math.round((now - a.askedAt) / 1000)} s old)`);
    // (a chat answer's lines are marked seen when its request settles: gmSettled)
    const world = this.world.world;
    let pid = a.response.player ?? a.pid;
    let actions = a.response.actions;
    if (!state.party.includes(pid)) {
      actions = actions.filter(isWordAction);
      pid = state.party[0]!;
    }
    if (a.hook.hook === 'chat') actions = actions.filter(isWordAction);
    // the target may have gone down while the answer was in flight: no harm or threat lands on them
    if (state.players[pid]?.down) actions = actions.filter((x) => !threatensPlayer(world, x));
    if (state.players[pid]?.pendingChoice) actions = actions.filter((x) => x.type !== 'offer_choice' && x.type !== 'trade');
    const re = recheckGmActions(world, state, actions, pid);
    if (re.dropped.length) this.log(`gm answer to ${a.hook.hook}: ${re.dropped.map((d) => `${d.type} (${d.reason})`).join(', ').slice(0, 300)} dropped by the recheck`);
    const ceiling = helpCeiling(state.difficulty ?? this.options.difficulty, state.area.partySize ?? 1);
    const capped = applyHelpCeiling(world, re.actions, Math.max(0, ceiling - this.helpUsed(state)), perspective(state, pid));
    const clean = sanitizeResponse({ actions: capped.actions });
    if (!clean) return;
    const body = { k: 'gm' as const, hook: a.hook.hook, pid, actions: clean.actions };
    if (!LogEntrySchema.safeParse({ ...body, n: 0, run: 0 }).success) return this.log(`gm answer to ${a.hook.hook} dropped (does not match the protocol)`);
    this.push(body);
  }

  /**
   * The NPC voice (design §4.3): after a turn entry, each conversation that opened or moved on
   * (voiceMoment, the rule the player's page shares) is voiced by the AI GM; a closed one is
   * forgotten. Words only, so nothing here makes an entry.
   */
  private voiceTurns(e: Extract<LogEntry, { k: 'turn' }>, before: GameState, r: Applied): void {
    const state = this.state;
    for (const pid of [...this.voiceHistory.keys()]) {
      const pc = state?.players[pid]?.pendingChoice;
      if (pc?.kind === 'dialogue' && pc.speakerId === this.voiceHistory.get(pid)!.npcId) continue;
      this.voiceHistory.delete(pid);
      this.gm?.dropVoice(pid);
    }
    const gm = this.gm;
    if (!gm || gm.mode !== 'ai' || !state || state.status !== 'playing' || this.phase !== 'playing') return;
    for (const inp of e.inputs) {
      const m = voiceMoment(before, r.state, inp.playerId, inp.actions, r.outcomes);
      if (!m) continue;
      const pc = state.players[inp.playerId]!.pendingChoice!;
      const prev = this.voiceHistory.get(inp.playerId);
      let lines: DialogueLine[] = [];
      if (m.kind === 'reply' && prev && prev.npcId === m.npcId) {
        lines = [...prev.lines, { speaker: 'npc' as const, text: prev.last }, ...(m.playerLine ? [{ speaker: 'player' as const, text: m.playerLine }] : [])].slice(-8);
      }
      this.voiceHistory.set(inp.playerId, { npcId: m.npcId, n: e.n, lines, last: pc.prompt });
      const pid = inp.playerId;
      const n = e.n;
      const run = this.run;
      gm.voice(
        { pid, n, npcId: m.npcId, state: perspective(state, pid), difficulty: state.difficulty ?? this.options.difficulty, history: lines, ...(m.kind === 'reply' && m.playerLine ? { playerLine: m.playerLine } : {}) },
        (text) => this.guard(() => this.sendVoice(run, pid, n, m.npcId, text), undefined),
      );
    }
  }

  /** a voiced line goes out only while that conversation is still on that turn (else the canned line stays) */
  private sendVoice(run: number, pid: PlayerId, n: number, npcId: string, text: string): void {
    const v = this.voiceHistory.get(pid);
    const pc = this.state?.players[pid]?.pendingChoice;
    if (this.closed || run !== this.run || this.phase !== 'playing' || !v || v.n !== n || v.npcId !== npcId || pc?.kind !== 'dialogue' || pc.speakerId !== npcId) {
      this.log(`gm voice for ${pid} dropped (the conversation moved on)`);
      return;
    }
    v.last = text;
    this.broadcast({ t: 'npc', run, n, pid, actorId: npcId, text });
  }

  /** after an entry: run end, area change (snapshot, hold, pending cleared), snapshot cadence */
  private settle(before: GameState, after: GameState): void {
    const now = this.deps.scheduler.now();
    if (after.status !== 'playing' && this.phase === 'playing') {
      this.phase = 'ended';
      this.gm?.cancelAll();
      this.pending.clear();
      this.firstAt = null;
      this.hold = null;
      this.snapshot();
      this.log(`run ${this.run} ${after.status} after ${this.n} entries`);
      return;
    }
    if (changedArea(before, after)) {
      // (before the new area's area_enter is asked: push asks after settle)
      this.gm?.cancelAll();
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
    if (this.chatOwed) wakes.push(this.lastChatHookAt + CHAT_ADDRESS_ROOM_MS);
    return {
      active,
      ready,
      pending,
      firstAt: this.firstAt,
      lastResolveAt: this.lastResolveAt,
      deadlineMs: t.deadlineMs || this.options.deadlineMs,
      travelMs: t.travelMs,
      countdownTurnMs: t.countdownTurnMs,
      calmGraceMs: t.calmGraceMs,
      calm: !hostileInView(state),
      calmFlow: t.calmFlow,
      downWaiting: state.status === 'playing' && state.party.some((id) => state.players[id]?.down) && state.party.some((id) => !state.players[id]?.down),
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
      // (only within BUSY_MAX_TURNS of the typing start: a typist who keeps acting does not stay immune)
      for (const s of this.seats) this.typingHoldsBusy(s);
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
    if (this.chatOwed) this.flushChatOwed(now);
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
    // (typing is left out: the typing frames carry it, and a roster to every seat on every
    // keystroke toggle was most of a chatting room's traffic, MP5; clients fold it back in)
    if (ps?.pendingChoice) return 'busy';
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
      return { seat: s.id, pid: s.pid, name: s.name, colour: s.colour, host: this.host === s.id, connected: !!s.conn, presence: p, since: s.since, ready: s.ready };
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
    let text: string | null = null;
    for (const s of this.seats) {
      if (!s.conn) continue;
      if (!s.conn.sendText) {
        safeSend(s.conn, msg);
        continue;
      }
      text ??= JSON.stringify(msg);
      try {
        s.conn.sendText(text);
      } catch {
        // a dead socket: its close handler takes the seat off
      }
    }
  }

  // -------------------------------------------------------------------------
  // Info, persistence, closing
  // -------------------------------------------------------------------------

  /** the room as listed; after a run its world is the one the next start plays (a world picked or uploaded since) */
  info(): RoomInfo {
    const rw = this.phase === 'ended' && this.nextWorld ? this.nextWorld : this.world;
    const w = rw.world;
    return {
      code: this.code,
      world: { id: rw.worldId, title: w.meta.title, genre: w.meta.genre, language: w.meta.language },
      players: this.seats.length,
      maxPlayers: this.options.maxPlayers,
      phase: this.phase,
      joinable: !this.closed && this.seats.length < this.options.maxPlayers,
      gm: this.phase === 'playing' && rw === this.world ? this.gmMode() : roomGmMode(this.deps.gm?.config, rw.source),
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
    if (truncate) this.logLines = 0;
  }

  /** a snapshot of the state now: the room file is rewritten and the log truncated */
  snapshot(): void {
    if (!this.state) return;
    this.stored = { snapshot: { n: this.n, state: serialize(this.state) }, hooks: cloneTracker(this.tracker) };
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
    this.gm?.dispose();
    for (const s of this.seats) {
      if (!s.conn) continue;
      safeSend(s.conn, { t: 'closed', reason, message });
      safeClose(s.conn, CLOSE.closed, reason);
      s.conn = null;
    }
    this.log(`closed (${reason})`);
    this.deps.onClose?.(this, reason);
    this.dropNextWorld();
  }

  /** graceful shutdown: a snapshot (or the room file), then `bye` to every connection */
  shutdown(): void {
    if (this.closed) return;
    this.deps.scheduler.cancel(this.timer);
    this.timer = null;
    this.gm?.dispose();
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
