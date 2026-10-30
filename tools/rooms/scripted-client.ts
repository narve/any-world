/**
 * Scripted room clients (MP2 design §11): a RoomClient (src/net/client.ts) over `ws`, driven by a sim
 * bot that decides on the client's own replica, with an optional chat script and a FaultyChannel
 * between the client and its socket. The exit-check tests (tests/server/rooms-exit.test.ts) and
 * tools/room-bots.ts use it; it never touches the server's state, only the protocol.
 *
 * The bot sends one turn action per ready turn with intent 'decide' (so turns resolve on round-trips,
 * not deadlines) and its free actions (talk, choices, sneak) one at a time as they come, each after
 * the previous one's entry arrived, as runParty does. A chat line is preceded by `typing`, which makes
 * the seat busy on the server. A watchdog re-decides when nothing moved for `retryMs` (a lost input or
 * a refusal the bot did not see).
 *
 * FaultyChannel models what a WebSocket over TCP does on a bad network: every frame is delayed with
 * seeded jitter (in order), the incoming side stalls now and then (nothing for `stallMs`, then a
 * burst), the socket is closed at random (the client reconnects with its token and lastN), and a share
 * of outgoing inputs is lost (a lost input behaves like a late one: the deadline resolves the turn).
 */
import WebSocket from 'ws';
import { readyPlayers } from '../../src/engine/index';
import { FREE_ACTIONS } from '../../src/engine/party';
import { botByName, newMemory, type Bot, type BotMemory, type BotName } from '../../src/engine/sim/bots';
import { MAX_FREE_PER_TURN } from '../../src/engine/sim/party';
import type { GameState, PlayerAction, PlayerId } from '../../src/engine/types';
import { RoomClient, type RoomEvent, type RoomSocket, type SocketFactory } from '../../src/net/client';
import type { NetNotice } from '../../src/net/messages';
import type { ChatLine, LogEntry, PLAYER_COLOURS, ServerMsg, Welcome } from '../../src/net/protocol';

/** a small seeded generator (mulberry32) for the faults and the chat timing */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a `ws` socket with an Origin header, as RoomClient wants it */
export function wsFactory(origin: string): SocketFactory {
  return (url) => new WebSocket(url, { headers: { origin } }) as unknown as RoomSocket;
}

// ---------------------------------------------------------------------------
// FaultyChannel
// ---------------------------------------------------------------------------

export interface FaultOptions {
  /** delay of every frame, both ways, uniform in [min, max] ms (order kept) */
  delayMs?: [number, number];
  /** about one incoming frame in this many starts a stall */
  stallEvery?: number;
  /** how long a stall holds the incoming frames */
  stallMs?: number;
  /** about one incoming frame in this many is followed by a dropped socket (then a reconnect) */
  closeEvery?: number;
  /** share of outgoing inputs that are lost (0–1) */
  dropInputs?: number;
  seed: number;
}

export interface FaultStats {
  frames: number;
  stalls: number;
  closes: number;
  droppedInputs: number;
}

/** callbacks run in order, each not before its time (one timer per queue) */
class DelayQueue {
  private items: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** the time the last item runs at (later items never run before it) */
  last = 0;

  push(at: number, fn: () => void): void {
    this.last = Math.max(this.last, at);
    this.items.push({ at: this.last, fn });
    this.arm();
  }

  private arm(): void {
    if (this.timer || !this.items.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      while (this.items.length && this.items[0].at <= now) this.items.shift()!.fn();
      this.arm();
    }, Math.max(0, this.items[0].at - Date.now()));
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.items = [];
  }
}

export class FaultyChannel {
  readonly stats: FaultStats = { frames: 0, stalls: 0, closes: 0, droppedInputs: 0 };
  private readonly rand: () => number;
  private queues: DelayQueue[] = [];
  /** drops the client's socket (set by the owner: RoomClient.drop, which then reconnects) */
  dropper: (() => void) | null = null;

  constructor(
    readonly opts: FaultOptions,
    private readonly inner: SocketFactory,
  ) {
    this.rand = rng(opts.seed);
  }

  /** the factory to give RoomClient */
  readonly factory: SocketFactory = (url) => this.wrap(this.inner(url));

  private delay(): number {
    const [lo, hi] = this.opts.delayMs ?? [0, 0];
    return lo + this.rand() * (hi - lo);
  }

  private wrap(real: RoomSocket): RoomSocket {
    const incoming = new DelayQueue();
    const outgoing = new DelayQueue();
    this.queues.push(incoming, outgoing);
    const later = (q: DelayQueue, fn: () => void) => q.push(Date.now() + this.delay(), fn);
    const proxy: RoomSocket = {
      get readyState() {
        return real.readyState;
      },
      send: (data: string) => {
        if (this.opts.dropInputs && data.startsWith('{"t":"input"') && this.rand() < this.opts.dropInputs) {
          this.stats.droppedInputs++;
          return;
        }
        later(outgoing, () => {
          if (real.readyState === 1) real.send(data);
        });
      },
      close: (code?: number, reason?: string) => {
        incoming.clear();
        outgoing.clear();
        real.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    real.onopen = (ev) => later(incoming, () => proxy.onopen?.(ev));
    real.onerror = (ev) => later(incoming, () => proxy.onerror?.(ev));
    real.onclose = (ev) => later(incoming, () => proxy.onclose?.(ev));
    real.onmessage = (ev) => {
      this.stats.frames++;
      if (this.opts.stallEvery && this.opts.stallMs && this.rand() < 1 / this.opts.stallEvery) {
        this.stats.stalls++;
        incoming.last = Math.max(incoming.last, Date.now() + this.opts.stallMs);
      }
      const close = !!this.opts.closeEvery && this.rand() < 1 / this.opts.closeEvery;
      later(incoming, () => {
        proxy.onmessage?.(ev);
        if (close && this.dropper) {
          this.stats.closes++;
          this.dropper();
        }
      });
    };
    return proxy;
  }

  /** stops every queued frame (the client is done) */
  clear(): void {
    for (const q of this.queues) q.clear();
    this.queues = [];
  }
}

// ---------------------------------------------------------------------------
// ScriptedClient
// ---------------------------------------------------------------------------

export interface ScriptedOptions {
  /** ws(s)://host/api/ws */
  url: string;
  origin: string;
  room: string;
  name: string;
  colour: (typeof PLAYER_COLOURS)[number];
  token?: string;
  /** computeEngineVersion(root), or e.g. 'old' for the outdated check */
  engine: string;
  /** the sim bot deciding on the replica (default explorer) */
  bot?: BotName;
  /** bot memory seed */
  seed?: number;
  /** a chat line about every k entries (0 / undefined: none) */
  chatEvery?: number;
  /** how long typing shows before the line is sent (default 150 ms) */
  typingMs?: number;
  fault?: FaultOptions;
  /** re-decide after this long without a new entry (default 1000 ms) */
  retryMs?: number;
  backoffMs?: { min: number; max: number };
}

type RefusalMsg = Extract<ServerMsg, { t: 'refusal' }>;
type ErrorMsg = Extract<ServerMsg, { t: 'error' }>;

export class ScriptedClient {
  readonly client: RoomClient;
  readonly channel: FaultyChannel | null;
  readonly bot: Bot;
  readonly mem: BotMemory;
  /** every entry applied, in order (a snapshot leaves a gap; `snapshots` counts them) */
  readonly entries: LogEntry[] = [];
  /** the replica at the start of the current run (the `run` message), for replay checks */
  runStart: GameState | null = null;
  snapshots = 0;
  readonly refusals: RefusalMsg[] = [];
  readonly errors: ErrorMsg[] = [];
  readonly notices: NetNotice[] = [];
  readonly faults: string[] = [];
  /** turn and free actions sent (some may be lost by the channel) */
  sent = 0;
  /** chat lines sent */
  said = 0;
  private running = false;
  private thinkQueued = false;
  private turnKey = '';
  private turnSent = false;
  private freeThisTurn = 0;
  /** n when the last free action was sent (cleared by the next entry, a refusal or an error) */
  private outstanding: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private watchN = -1;
  private chatBucket = 0;
  private lastSaidAt = 0;
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly opts: ScriptedOptions) {
    this.bot = botByName(opts.bot ?? 'explorer');
    this.mem = newMemory(opts.seed ?? 1);
    this.channel = opts.fault ? new FaultyChannel(opts.fault, wsFactory(opts.origin)) : null;
    this.client = new RoomClient({
      url: opts.url,
      socket: this.channel ? this.channel.factory : wsFactory(opts.origin),
      engine: opts.engine,
      room: opts.room,
      name: opts.name,
      colour: opts.colour,
      ...(opts.token ? { token: opts.token } : {}),
      backoffMs: opts.backoffMs ?? { min: 50, max: 500 },
    });
    if (this.channel) this.channel.dropper = () => this.client.drop();
    this.client.on((e) => this.onEvent(e));
  }

  get state(): GameState | null {
    return this.client.state;
  }
  get pid(): PlayerId | null {
    return this.client.pid;
  }
  get n(): number {
    return this.client.n;
  }
  get chats(): ChatLine[] {
    return this.client.chat;
  }
  get desyncs(): number {
    return this.client.desyncs;
  }
  get reconnects(): number {
    return this.client.reconnects;
  }

  /** opens the socket; resolves on the first welcome (rejects with the notice key) */
  connect(): Promise<Welcome> {
    const p = this.client.joined();
    this.client.connect();
    return p;
  }

  /**
   * Drops the socket as a network failure would. With `stay`, the client stays off until
   * reconnect() (the server sees a disconnect, not a leave); otherwise it reconnects by itself.
   */
  drop(o: { stay?: boolean } = {}): void {
    if (o.stay) this.client.stop();
    else this.client.drop();
  }

  /** connects again after drop({ stay: true }); resolves on the welcome */
  reconnect(): Promise<Welcome> {
    return this.connect();
  }

  /** starts the bot; resolves once `entries` more entries were applied or the run ended */
  play(entries: number): Promise<void> {
    const target = this.n + entries;
    return this.playUntil(() => this.n >= target);
  }

  /** starts the bot; resolves when `done` holds or the run ended (the bot keeps playing until pause) */
  playUntil(done: () => boolean): Promise<void> {
    this.running = true;
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.nudge(), this.opts.retryMs ?? 1000);
      this.watchdog.unref?.();
    }
    this.queueThink();
    return new Promise((resolve) => {
      const check = () => {
        if (done() || this.ended()) return resolve();
        this.waiters.push(check);
      };
      check();
    });
  }

  /** the run is over (or the client stopped): play() resolves */
  ended(): boolean {
    return this.client.status === 'stopped' || this.client.phase === 'ended' || (!!this.state && this.state.status !== 'playing');
  }

  /** stops deciding (the socket stays open) */
  pause(): void {
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = null;
  }

  /** stops everything and closes the socket */
  async close(): Promise<void> {
    this.pause();
    this.client.stop();
    this.channel?.clear();
    for (const w of this.waiters.splice(0)) w();
  }

  // -------------------------------------------------------------------------

  private onEvent(e: RoomEvent): void {
    switch (e.t) {
      case 'entries':
        this.entries.push(...e.entries);
        for (const o of e.outcomes) {
          if (o.playerId !== this.pid) continue;
          this.mem.lastAction = o.action;
          this.mem.lastInvalid = o.ok ? null : (o.detail ?? 'refused');
          this.mem.lastReason = o.ok ? null : (o.reason ?? null);
          // (this player's turn action resolved: a hasted player may be ready again within the same
          // engine turn, so "sent for this turn" ends here, not only when the turn number changes)
          if (!FREE_ACTIONS.has(o.action.type)) this.turnSent = false;
        }
        this.outstanding = null;
        this.chatScript();
        break;
      case 'state':
        if (e.reason === 'run') {
          this.runStart = this.client.state;
          this.entries.length = 0;
        } else this.snapshots++;
        this.outstanding = null;
        this.turnKey = '';
        break;
      case 'welcome':
        this.outstanding = null;
        this.turnKey = '';
        break;
      case 'notice':
        this.notices.push(e.notice);
        break;
      case 'fault':
        this.faults.push(e.reason);
        break;
      case 'message':
        if (e.msg.t === 'refusal') {
          this.refusals.push(e.msg);
          const mine = e.msg.reasons.at(-1);
          if (mine) {
            this.mem.lastAction = mine.action;
            this.mem.lastInvalid = mine.detail ?? mine.reason;
            this.mem.lastReason = mine.reason as BotMemory['lastReason'];
          }
          this.outstanding = null;
          this.turnSent = false;
        } else if (e.msg.t === 'error') {
          this.errors.push(e.msg);
          this.outstanding = null;
          if (e.msg.code === 'stale') this.turnSent = false;
        } else return;
        break;
      default:
        return;
    }
    this.queueThink();
    for (const w of this.waiters.splice(0)) w();
  }

  private queueThink(): void {
    if (this.thinkQueued || !this.running) return;
    this.thinkQueued = true;
    setImmediate(() => {
      this.thinkQueued = false;
      this.think();
    });
  }

  /** nothing moved since the last look: forget what was sent and decide again */
  private nudge(): void {
    if (!this.running) return;
    if (this.n === this.watchN) {
      this.outstanding = null;
      this.turnSent = false;
    }
    this.watchN = this.n;
    this.queueThink();
  }

  private think(): void {
    const c = this.client;
    const s = c.state;
    const pid = c.pid;
    if (!this.running || c.status !== 'joined' || c.phase !== 'playing' || !s || s.status !== 'playing' || !pid || !c.world) return;
    const ps = s.players[pid];
    if (!ps || ps.down || !s.party.includes(pid) || this.outstanding !== null) return;
    const key = `${s.area.index}:${s.turn}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.turnSent = false;
      this.freeThisTurn = 0;
    }
    const ready = readyPlayers(s, { world: c.world }).includes(pid);
    const choosing = !!ps.pendingChoice || !!ps.pendingPerkChoice;
    if (!choosing && (!ready || this.turnSent)) return;
    let action: PlayerAction;
    try {
      action = this.bot.decide(s, c.world, this.mem, pid);
    } catch (err) {
      this.faults.push(`bot: ${err instanceof Error ? err.message : String(err)}`);
      action = { type: 'wait' };
    }
    if (FREE_ACTIONS.has(action.type)) {
      if (this.freeThisTurn < MAX_FREE_PER_TURN) {
        this.freeThisTurn++;
        this.outstanding = c.n;
        this.sent++;
        c.input([action], 'decide');
        return;
      }
      if (!ready || this.turnSent) return;
      action = { type: 'wait' };
    }
    if (!ready) return;
    this.turnSent = true;
    this.sent++;
    c.input([action], 'decide');
  }

  /** a chat line about every chatEvery entries: typing first, the line typingMs later (1 a second at most) */
  private chatScript(): void {
    const every = this.opts.chatEvery;
    if (!every || !this.running || this.chatTimer) return;
    const bucket = Math.floor(this.n / every);
    if (bucket <= this.chatBucket) return;
    if (Date.now() - this.lastSaidAt < 1100) return;
    this.chatBucket = bucket;
    this.client.typing(true);
    this.chatTimer = setTimeout(() => {
      this.chatTimer = null;
      this.lastSaidAt = Date.now();
      if (this.client.say(`${this.opts.name} at ${this.n}: line ${this.said + 1}`)) this.said++;
    }, this.opts.typingMs ?? 150);
  }
}
