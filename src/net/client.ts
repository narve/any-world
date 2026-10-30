/**
 * RoomClient (MP2 design §1, §2, §4): one player's connection to a room. It owns the socket (from
 * an injected factory: the browser's WebSocket in MP3, `ws` in Node for the scripted clients), sends
 * `hello` on every (re)connect, keeps the room's replica of the game state by applying the entries
 * in order with applyEntry (lockstep), reports hashState every LIMITS.hashEvery entries and
 * `applied` after an area change, and reconnects with its token and lastN after a dropped socket
 * or a server restart (`bye`), with backoff 0.5–5 s. It never reconnects after `refused`, `closed`,
 * a replaced socket (another tab) or leave(); those end in a `notice` event (noticeFor) or `stopped`.
 *
 * MP3 adds the lobby messages (ready, profile, world, ping, options with difficulty), keeps the room
 * info, options, typing seats and the last clock frame, emits the applied entries one step each
 * (`steps`, with the state before and after, so the browser can derive toasts and narration per
 * entry; `catchUp` marks the welcome's batch) and records why it stopped (`stopReason`, the close code).
 *
 * Every frame is validated with parseServerMsg. The world in welcome / run is parsed with parseWorld
 * and its worldIdOf must equal the server's worldId, else the client refuses to play (`fault`).
 * A gap in the entries or an entry the engine refuses means the replica is wrong: the client
 * reconnects without lastN and gets a fresh snapshot.
 *
 * Imports only the engine, the schema and the protocol (no DOM, no node: modules).
 */
import { deserialize, hashState, registerWorld, worldIdOf } from '../engine/index';
import type { GameEvent, GameState, PlayerAction, PlayerId, TurnOutcome } from '../engine/types';
import { parseWorld } from '../schema';
import type { WorldSpec } from '../schema/world';
import { applyEntry, changedArea } from './log';
import { noticeFor, type NetNotice } from './messages';
import {
  CLOSE,
  LIMITS,
  parseServerMsg,
  PLAYER_COLOURS,
  PROTOCOL,
  REFUSED_CLOSE,
  type ChatLine,
  type ClientMsg,
  type ClockMsg,
  type Closed,
  type Intent,
  type LogEntry,
  type Phase,
  type PingKind,
  type Presence,
  type Refused,
  type RoomInfo,
  type RoomOptions,
  type RosterEntry,
  type ServerMsg,
  type Welcome,
} from './protocol';

/** what RoomClient needs of a socket (the browser WebSocket and ws's WebSocket both fit) */
export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RoomSocket;

/** WebSocket.OPEN */
const OPEN = 1;

export interface RoomClientOptions {
  /** ws(s)://host/api/ws */
  url: string;
  socket: SocketFactory;
  /** this page's engine version (ENGINE_VERSION in the browser) */
  engine: string;
  room: string;
  name: string;
  colour: (typeof PLAYER_COLOURS)[number];
  /** a seat token from an earlier join (MP3 keeps it in localStorage per room code) */
  token?: string;
  /** reconnect after a dropped socket (default true) */
  reconnect?: boolean;
  /** reconnect backoff (default 500 → 5000 ms, doubling) */
  backoffMs?: { min: number; max: number };
  /** timers (tests) */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export type RoomClientStatus = 'connecting' | 'joined' | 'reconnecting' | 'stopped';

/** one applied entry: the replica before and after it, and what the engine said */
export interface EntryStep {
  entry: LogEntry;
  before: GameState;
  after: GameState;
  events: GameEvent[];
  outcomes: TurnOutcome[];
}

export type RoomEvent =
  /** joined (also after every reconnect); the replica is ready when the room is playing */
  | { t: 'welcome'; msg: Welcome }
  /**
   * entries applied to the replica, with the engine events and action outcomes they produced (all
   * of them, and per entry in `steps`); `catchUp`: the entries of a welcome (a reconnect catching up),
   * not live play
   */
  | { t: 'entries'; entries: LogEntry[]; events: GameEvent[]; outcomes: TurnOutcome[]; steps: EntryStep[]; catchUp: boolean }
  /** the replica was replaced: a desync snapshot, a new run, or a welcome snapshot */
  | { t: 'state'; reason: 'welcome' | 'snapshot' | 'run' }
  /** refused or closed by the server: the toast to show (MP3); the client has stopped */
  | { t: 'notice'; notice: NetNotice; msg: Refused | Closed }
  /** the replica cannot be trusted: a world mismatch stops the client; a gap or a refused entry reconnects */
  | { t: 'fault'; reason: 'world_invalid' | 'world_mismatch' | 'gap' | 'apply' | 'invalid_message'; detail?: string }
  /** `stopReason` on `stopped`: the close code that ended it (4007 another tab, 1008 policy, a refusal's or close's code); none after stop() or leave() */
  | { t: 'status'; status: RoomClientStatus; stopReason?: number }
  /** every other message (roster, room, chat, typing, clock, refusal, error, bye) after the client handled it */
  | { t: 'message'; msg: ServerMsg };

export class RoomClient {
  readonly opts: RoomClientOptions;
  status: RoomClientStatus = 'connecting';
  token: string | undefined;
  seat: string | null = null;
  pid: PlayerId | null = null;
  host = false;
  phase: Phase | null = null;
  run = 0;
  /** entries applied in this run (the next entry's n) */
  n = 0;
  world: WorldSpec | null = null;
  worldId: string | null = null;
  state: GameState | null = null;
  options: RoomOptions | null = null;
  /** the room as the server lists it (welcome, then `room` messages) */
  room: RoomInfo | null = null;
  /** the roster as shown: the server's, with a typing seat that is on and not otherwise busy shown 'busy' */
  roster: RosterEntry[] = [];
  /** the roster as the server sent it (typing is not in it, MP5) */
  private serverRoster: RosterEntry[] = [];
  chat: ChatLine[] = [];
  /** seats typing now (typing frames; cleared on a welcome) */
  typingSeats = new Set<string>();
  /** the last clock frame of this run */
  clock: ClockMsg | null = null;
  /** the close code that stopped the client (undefined while running, and after stop() or leave()) */
  stopReason: number | undefined;
  /** snapshots received after a hash mismatch */
  desyncs = 0;
  /** successful joins after the first */
  reconnects = 0;
  /** invalid server frames (ignored) */
  invalid = 0;
  private ws: RoomSocket | null = null;
  private listeners = new Set<(e: RoomEvent) => void>();
  private retryTimer: unknown = null;
  private backoff: number;
  private joinedOnce = false;
  /** the next hello asks for a full snapshot (the replica is wrong) */
  private fresh = false;

  constructor(opts: RoomClientOptions) {
    this.opts = opts;
    this.token = opts.token;
    this.backoff = opts.backoffMs?.min ?? 500;
  }

  on(fn: (e: RoomEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: RoomEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  private setStatus(s: RoomClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit({ t: 'status', status: s });
  }

  /** opens the socket (and keeps it open, reconnecting, until stop / refused / closed) */
  connect(): void {
    if (this.status === 'stopped') this.status = 'connecting';
    this.stopReason = undefined;
    this.open();
  }

  /** resolves on the first welcome, rejects on a notice or a fault that stops the client */
  joined(): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const off = this.on((e) => {
        if (e.t === 'welcome') {
          off();
          resolve(e.msg);
        } else if (e.t === 'notice' || (e.t === 'fault' && e.reason.startsWith('world')) || (e.t === 'status' && e.status === 'stopped')) {
          off();
          reject(Object.assign(new Error(e.t === 'notice' ? e.notice.key : e.t === 'fault' ? e.reason : 'stopped'), { event: e }));
        }
      });
    });
  }

  private open(): void {
    const ws = this.opts.socket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendRaw(this.helloMsg());
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onFrame(ev.data);
    };
    ws.onerror = () => {
      // onclose follows
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClosed(ev.code);
    };
  }

  private helloMsg(): ClientMsg {
    const h: ClientMsg = { t: 'hello', v: PROTOCOL, engine: this.opts.engine, room: this.opts.room, name: this.opts.name, colour: this.opts.colour };
    if (this.token) h.token = this.token;
    if (this.joinedOnce) {
      h.run = this.run;
      if (this.state && !this.fresh) h.lastN = this.n;
    }
    return h;
  }

  private onClosed(code: number): void {
    // the server said why (refused / closed) or we left: no reconnect
    if (this.status === 'stopped') return;
    const final = code === CLOSE.replaced || code === CLOSE.closed || (code >= 4001 && code <= 4006) || code === CLOSE.policy;
    if (final || this.opts.reconnect === false) return this.stop(code);
    this.setStatus('reconnecting');
    const ms = this.backoff;
    this.backoff = Math.min(this.opts.backoffMs?.max ?? 5000, this.backoff * 2);
    const set = this.opts.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d));
    this.retryTimer = set(() => {
      this.retryTimer = null;
      if (this.status === 'reconnecting') this.open();
    }, ms);
  }

  /** closes the socket now and does not reconnect (`reason`: the close code that ended it, for the stopped status) */
  stop(reason?: number): void {
    const was = this.status;
    this.status = 'stopped';
    if (was !== 'stopped') this.stopReason = reason;
    if (this.retryTimer !== null) (this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'bye');
      } catch {
        // already closed
      }
    }
    if (was !== 'stopped') this.emit({ t: 'status', status: 'stopped', ...(reason !== undefined ? { stopReason: reason } : {}) });
  }

  /** drops the socket as a network failure would (it reconnects; tests and the fault channel) */
  drop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try {
      ws.close(4999, 'drop');
    } catch {
      // already closed
    }
    this.onClosed(1006);
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  private onFrame(data: unknown): void {
    const msg = parseServerMsg(typeof data === 'string' ? data : String(data));
    if (!msg) {
      this.invalid++;
      this.emit({ t: 'fault', reason: 'invalid_message' });
      return;
    }
    switch (msg.t) {
      case 'welcome':
        return this.onWelcome(msg);
      case 'entries':
        if (msg.run !== this.run || !this.state) return;
        return this.applyAll(msg.es, false);
      case 'snapshot':
        if (msg.run !== this.run || !this.world) return;
        this.desyncs++;
        this.setState(deserialize(this.world, msg.state), msg.n);
        return this.emit({ t: 'state', reason: 'snapshot' });
      case 'run': {
        if (!this.takeWorld(msg.world, msg.worldId)) return;
        this.run = msg.run;
        this.phase = 'playing';
        this.clock = null;
        this.setState(deserialize(this.world!, msg.snapshot.state), msg.snapshot.n);
        return this.emit({ t: 'state', reason: 'run' });
      }
      case 'roster':
        this.setRoster(msg.seats);
        break;
      case 'room':
        this.room = msg.room;
        this.options = msg.options;
        break;
      case 'clock':
        this.clock = msg;
        break;
      case 'typing':
        if (msg.on) this.typingSeats.add(msg.seat);
        else this.typingSeats.delete(msg.seat);
        this.foldTyping();
        break;
      case 'chat':
        this.chat.push(msg.line);
        if (this.chat.length > LIMITS.chatHistory) this.chat.splice(0, this.chat.length - LIMITS.chatHistory);
        break;
      case 'refused':
      case 'closed':
        this.emit({ t: 'notice', notice: noticeFor(msg), msg });
        // (the server closes the socket with this code right after the message)
        return this.stop(msg.t === 'refused' ? REFUSED_CLOSE[msg.code] : CLOSE.closed);
      case 'bye':
        // the server restarts: the socket closes (1012) and onClosed reconnects
        break;
      default:
        break;
    }
    this.emit({ t: 'message', msg });
  }

  private onWelcome(msg: Welcome): void {
    if (!this.takeWorld(msg.world, msg.worldId)) return;
    this.token = msg.you.token;
    this.seat = msg.you.seat;
    this.pid = msg.you.pid;
    this.host = msg.you.host;
    this.phase = msg.phase;
    this.options = msg.options;
    this.room = msg.room;
    this.chat = msg.chat.slice();
    this.typingSeats.clear();
    this.setRoster(msg.roster);
    if (msg.run !== this.run) {
      this.run = msg.run;
      this.state = null;
      this.n = 0;
      this.clock = null;
    }
    this.fresh = false;
    if (this.joinedOnce) this.reconnects++;
    this.joinedOnce = true;
    this.backoff = this.opts.backoffMs?.min ?? 500;
    this.setStatus('joined');
    if (msg.snapshot) {
      this.setState(deserialize(this.world!, msg.snapshot.state), msg.snapshot.n);
      this.emit({ t: 'state', reason: 'welcome' });
    }
    this.emit({ t: 'welcome', msg });
    if (msg.entries?.length) this.applyAll(msg.entries, true);
  }

  /** a world from the server (or none: keep ours), checked against its worldId */
  private takeWorld(raw: unknown, worldId: string): boolean {
    if (raw !== undefined) {
      const r = parseWorld(raw);
      if (!r.ok) return this.worldFault('world_invalid', r.errors.slice(0, 3).join('; '));
      const id = worldIdOf(r.world);
      if (id !== worldId) return this.worldFault('world_mismatch', `${id} ≠ ${worldId}`);
      // the registry serves the engine's view helpers (legalActions…) in the UI and the bots
      registerWorld(r.world);
      this.world = r.world;
      this.worldId = id;
      return true;
    }
    if (!this.world || this.worldId !== worldId) return this.worldFault('world_mismatch', `no world for ${worldId}`);
    return true;
  }

  private worldFault(reason: 'world_invalid' | 'world_mismatch', detail: string): false {
    this.emit({ t: 'fault', reason, detail });
    this.stop();
    return false;
  }

  private setRoster(seats: RosterEntry[]): void {
    this.serverRoster = seats;
    this.foldTyping();
    const me = seats.find((s) => s.seat === this.seat);
    if (me) {
      this.pid = me.pid;
      this.host = me.host;
    }
  }

  /** typing shows as busy on a connected seat that is active, idle or in a menu (as the server did before MP5) */
  private foldTyping(): void {
    this.roster = this.serverRoster.map((r) => (this.typingSeats.has(r.seat) && (r.presence === 'active' || r.presence === 'idle' || r.presence === 'menu') ? { ...r, presence: 'busy' as const } : r));
  }

  private setState(state: GameState, n: number): void {
    this.state = state;
    this.n = n;
    this.settle();
  }

  /** a run that is won or lost has ended, as the server's settle() marks it (no message says so) */
  private settle(): void {
    if (this.phase === 'playing' && this.state && this.state.status !== 'playing') this.phase = 'ended';
  }

  private applyAll(es: LogEntry[], catchUp: boolean): void {
    const applied: LogEntry[] = [];
    const events: GameEvent[] = [];
    const outcomes: TurnOutcome[] = [];
    const steps: EntryStep[] = [];
    for (const e of es) {
      if (e.run !== this.run || e.n < this.n) continue;
      if (e.n > this.n) {
        this.resync('gap', `expected ${this.n}, got ${e.n}`);
        break;
      }
      const before = this.state!;
      let after: GameState;
      try {
        const r = applyEntry(this.world!, before, e);
        after = r.state;
        events.push(...r.events);
        outcomes.push(...r.outcomes);
        steps.push({ entry: e, before, after, events: r.events, outcomes: r.outcomes });
      } catch (err) {
        this.resync('apply', err instanceof Error ? err.message : String(err));
        break;
      }
      this.state = after;
      this.n = e.n + 1;
      this.settle();
      applied.push(e);
      if (changedArea(before, after)) this.sendRaw({ t: 'applied', n: this.n });
      if (this.n % LIMITS.hashEvery === 0) this.sendRaw({ t: 'hash', n: this.n, h: hashState(after) });
    }
    if (applied.length) this.emit({ t: 'entries', entries: applied, events, outcomes, steps, catchUp });
  }

  /** the replica is wrong: reconnect and ask for a snapshot */
  private resync(reason: 'gap' | 'apply', detail: string): void {
    this.emit({ t: 'fault', reason, detail });
    this.fresh = true;
    this.drop();
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  private sendRaw(msg: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** any client message while joined (false when there is no open, joined socket) */
  send(msg: ClientMsg): boolean {
    if (this.status !== 'joined') return false;
    return this.sendRaw(msg);
  }

  /** this player's actions for the current area and turn (free actions and at most one turn action) */
  input(actions: PlayerAction[], intent: Intent = 'decide', busy?: boolean): boolean {
    const s = this.state;
    if (!s) return false;
    return this.send({ t: 'input', area: s.area.index, turn: s.turn, actions, intent, ...(busy !== undefined ? { busy } : {}) });
  }

  say(text: string): boolean {
    return this.send({ t: 'chat', text });
  }

  typing(on: boolean): boolean {
    return this.send({ t: 'typing', on });
  }

  presence(state: Presence): boolean {
    return this.send({ t: 'presence', state });
  }

  /** host only: start a run (or play again); `demo` is for the scripted clients, the MP3 client picks the world with world() first */
  start(demo?: string): boolean {
    return this.send({ t: 'start', ...(demo !== undefined ? { demo } : {}) });
  }

  /** the lobby's ready toggle (lobby and ended phases) */
  ready(on: boolean): boolean {
    return this.send({ t: 'ready', on });
  }

  /** a new name and colour (lobby and ended phases; the server makes them unique) */
  profile(name: string, colour: (typeof PLAYER_COLOURS)[number]): boolean {
    return this.send({ t: 'profile', name, colour });
  }

  /** host only: the demo world of the next run (lobby and ended phases) */
  pickWorld(demo: string): boolean {
    return this.send({ t: 'world', demo });
  }

  /** host only: room options (difficulty in the lobby and ended phases only) */
  setOptions(o: Partial<RoomOptions>): boolean {
    return this.send({ t: 'options', ...o });
  }

  /** a map ping at a tile of the current area (playing; shares the chat rate) */
  ping(kind: PingKind, pos: { x: number; y: number }): boolean {
    return this.send({ t: 'ping', kind, x: pos.x, y: pos.y });
  }

  /** leaves the room (the seat is kept for 2 minutes, design §3) and stops */
  leave(): void {
    this.send({ t: 'leave' });
    this.stop();
  }
}
