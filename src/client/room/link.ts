/**
 * RoomLink (MP3 design §1, §2.3, §3.6, §5): this page's connection to one room, for as long as the
 * player stays in it (runs come and go; the link and its ChatModel live for the whole room). It
 * builds the RoomClient (the browser's WebSocket by default), keeps the seat token per room code
 * (profile.ts), sends `presence` on change only (`menu` while any menu reason is set or the tab is
 * hidden, else `playing`), feeds the ChatModel and turns the client's notices, faults and stop
 * reasons into what the app shows:
 *  - `end`: back to the start page with a toast (a closed room, a full one, another tab, a world
 *    this page cannot load); the token is dropped except for a full room;
 *  - `reload`: this page is outdated; the room view stays (a sticky toast with Reload);
 *  - `toast`: a short notice (a bad token: the seat is dropped and the client joins as new; a host
 *    action the server refused);
 *  - `welcome`, `run`, `changed`, `status`, `chat`: the app re-renders.
 *
 * The DOM is only touched through the injectable `doc` (visibility) and `socket` (WebSocket), so
 * tests run it against the in-memory room harness.
 */
import { RoomClient, type RoomClientStatus, type SocketFactory } from '../../net/client';
import { CLOSE, type ChatLine, type Welcome } from '../../net/protocol';
import type { WorldSpec } from '../../schema/world';
import { ENGINE_VERSION } from '../../net/version';
import type { MessageKey } from '../i18n/index';
import type { WorldEntry, WorldIndexEntry } from '../worlds';
import { ChatModel } from './chat-model';
import { dropSeat, saveSeat, type KeyValueStore, type PlayerColour, type Profile } from './profile';

/** what RoomLink needs of the document: the tab's visibility */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface RoomLinkOptions {
  code: string;
  /** ws(s)://host/api/ws (RoomsEndpoint.ws) */
  url: string;
  profile: Profile;
  /** a stored seat token for this code */
  token?: string | null;
  socket?: SocketFactory;
  /** seat-token storage (default localStorage) */
  store?: KeyValueStore | null;
  /** tab visibility (default document; null: always visible) */
  doc?: VisibilityDoc | null;
  now?: () => number;
  engine?: string;
  /** client timers (tests) */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export type LinkEvent =
  /** joined; `first` for the first welcome of this link; `renamed`: the name and colour the server gave instead of the asked ones */
  | { t: 'welcome'; msg: Welcome; first: boolean; renamed: { name: string; colour: PlayerColour } | null }
  /** a new run started (play again): relaunch the session */
  | { t: 'run' }
  /** roster, room info or options changed */
  | { t: 'changed' }
  /** leave the room: back to the start page with this notice */
  | { t: 'end'; key: MessageKey }
  /** this page is outdated: show a sticky Reload toast, keep the view */
  | { t: 'reload' }
  | { t: 'toast'; key: MessageKey; tone: 'info' | 'warn' }
  | { t: 'status'; status: RoomClientStatus }
  | { t: 'chat'; line: ChatLine }
  /**
   * the server refused a chat line, emote or ping (too fast, too long, or dropped by the socket's
   * message bucket while a send waited for its echo): the chat shows "Wait a moment" and gives the
   * draft back
   */
  | { t: 'chatError'; code: 'chat_rate' | 'chat_long' | 'rate' };

/** how long a reconnect may take before the banner offers "Leave room" (design constants) */
export const RECONNECT_LEAVE_MS = 20_000;

/** errors from the server that mean a UI action raced the room (shown as room.notAllowed) */
const NOT_ALLOWED = new Set(['not_host', 'bad_phase', 'invalid']);

export class RoomLink {
  readonly code: string;
  readonly client: RoomClient;
  readonly chat = new ChatModel();
  /** when the current reconnect began (null while joined) */
  reconnectingSince: number | null = null;
  /** the link is over (left, or the room ended it) */
  closed = false;
  private listeners = new Set<(e: LinkEvent) => void>();
  private offClient: () => void;
  private menus = new Set<string>();
  private sentPresence: 'playing' | 'menu' | null = null;
  private welcomes = 0;
  /** a bad token: the client stopped and joins again as new (its stop is not the end) */
  private rejoining = false;
  /** this page is outdated (a reload notice): the client's stop that follows is not the end of the room view */
  private outdated = false;
  private readonly now: () => number;
  private readonly store: KeyValueStore | null | undefined;
  private readonly doc: VisibilityDoc | null;
  private profile: Profile;
  private onVisibility = () => this.syncPresence();

  constructor(opts: RoomLinkOptions) {
    this.code = opts.code;
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store;
    this.profile = opts.profile;
    this.doc = opts.doc === undefined ? (typeof document !== 'undefined' ? document : null) : opts.doc;
    const socket: SocketFactory = opts.socket ?? ((url) => new WebSocket(url) as unknown as ReturnType<SocketFactory>);
    this.client = new RoomClient({
      url: opts.url,
      socket,
      engine: opts.engine ?? ENGINE_VERSION,
      room: opts.code,
      name: opts.profile.name,
      colour: opts.profile.colour,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
      ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
    });
    this.offClient = this.client.on((e) => this.onClient(e));
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  on(fn: (e: LinkEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LinkEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  connect(): void {
    this.client.connect();
  }

  /** the profile asked for (the server may have made it unique) */
  get asked(): Profile {
    return this.profile;
  }

  /** a new name and colour (lobby and ended phases): kept for reconnects too */
  setProfile(p: Profile): boolean {
    this.profile = p;
    Object.assign(this.client.opts, { name: p.name, colour: p.colour });
    return this.client.profile(p.name, p.colour);
  }

  /** a menu (backpack, help, rules, settings, chat…) opened or closed: presence follows */
  setMenu(reason: string, open: boolean): void {
    if (open) this.menus.add(reason);
    else this.menus.delete(reason);
    this.syncPresence();
  }

  /** what this player's presence is now */
  get presence(): 'playing' | 'menu' {
    return this.menus.size || this.doc?.hidden ? 'menu' : 'playing';
  }

  private syncPresence(force = false): void {
    if (this.closed || this.client.status !== 'joined') return;
    const p = this.presence;
    if (!force && p === this.sentPresence) return;
    // (a reconnect starts the seat as playing: only a menu needs saying again)
    if (force && p === 'playing') {
      this.sentPresence = p;
      return;
    }
    if (this.client.presence(p)) this.sentPresence = p;
  }

  /** leaves the room for good (the seat is kept by the server for 2 minutes; this page forgets it) */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    dropSeat(this.code, this.now(), this.store);
    this.client.leave();
    this.dispose();
  }

  dispose(): void {
    this.closed = true;
    this.offClient();
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    if (this.client.status !== 'stopped') this.client.stop();
    this.listeners.clear();
  }

  /** ends the link with a notice (the client has stopped or is stopped here) */
  private end(key: MessageKey, keepSeat = false): void {
    if (this.closed) return;
    if (!keepSeat) dropSeat(this.code, this.now(), this.store);
    const fns = [...this.listeners];
    this.dispose();
    for (const fn of fns) fn({ t: 'end', key });
  }

  private onClient(e: Parameters<Parameters<RoomClient['on']>[0]>[0]): void {
    if (this.closed) return;
    const c = this.client;
    switch (e.t) {
      case 'welcome': {
        const first = this.welcomes++ === 0;
        if (c.token) saveSeat(this.code, c.token, this.now(), this.store);
        this.chat.self = c.seat;
        this.chat.merge(e.msg.chat);
        this.reconnectingSince = null;
        this.sentPresence = null;
        this.syncPresence(true);
        const me = e.msg.roster.find((r) => r.seat === c.seat);
        const renamed = first && me && (me.name !== this.profile.name || me.colour !== this.profile.colour) ? { name: me.name, colour: me.colour } : null;
        this.emit({ t: 'welcome', msg: e.msg, first, renamed });
        return;
      }
      case 'state':
        if (e.reason === 'run') this.emit({ t: 'run' });
        return;
      case 'notice': {
        const key = e.notice.key;
        if (key === 'net.badToken') {
          // the seat is gone (a restart lost it, or it expired): join as new with the same profile
          dropSeat(this.code, this.now(), this.store);
          this.rejoining = true;
          this.emit({ t: 'toast', key: 'net.badToken', tone: 'info' });
          // (the client stops itself right after this event: connect once it has)
          setTimeout(() => {
            if (this.closed) return;
            this.rejoining = false;
            c.token = undefined;
            c.connect();
          }, 0);
          this.welcomes = 0;
          return;
        }
        if (e.notice.reload) {
          this.outdated = true;
          this.emit({ t: 'reload' });
          return;
        }
        return this.end(key, key === 'net.roomFull');
      }
      case 'fault':
        if (e.reason === 'world_invalid' || e.reason === 'world_mismatch') this.end('room.worldMismatch', true);
        return;
      case 'status':
        if (e.status === 'reconnecting') this.reconnectingSince ??= this.now();
        else if (e.status === 'joined') this.reconnectingSince = null;
        else if (e.status === 'stopped' && !this.rejoining && !this.outdated) {
          if (e.stopReason === CLOSE.replaced) return this.end('room.otherTab', true);
          if (e.stopReason === CLOSE.policy) return this.end('room.notAllowed', true);
          // (any other stop without a notice: the room is gone for this page)
          return this.end('net.roomClosed', true);
        }
        this.emit({ t: 'status', status: e.status });
        return;
      case 'message': {
        const m = e.msg;
        if (m.t === 'chat') {
          this.chat.push(m.line, this.now());
          this.emit({ t: 'chat', line: m.line });
        } else if (m.t === 'typing') {
          this.chat.setTyping(m.seat, m.on, this.now());
          this.emit({ t: 'changed' });
        } else if (m.t === 'roster' || m.t === 'room') this.emit({ t: 'changed' });
        else if (m.t === 'error' && (m.code === 'chat_rate' || m.code === 'chat_long' || (m.code === 'rate' && this.chat.awaitingEcho))) {
          this.chat.awaitingEcho = false;
          this.emit({ t: 'chatError', code: m.code });
        }
        // (an input or a ping that crossed the end of the run on the wire: nothing the player did wrong)
        else if (m.t === 'error' && m.code === 'bad_phase' && this.client.phase !== 'playing') console.info(`[anyworld] room: ${m.code} ${m.message}`);
        else if (m.t === 'error' && m.code === 'offer_gone') this.emit({ t: 'toast', key: 'room.offerGone', tone: 'warn' });
        else if (m.t === 'error' && NOT_ALLOWED.has(m.code)) {
          console.warn(`[anyworld] room refused an action (${m.code}): ${m.message}`);
          this.emit({ t: 'toast', key: 'room.notAllowed', tone: 'warn' });
        } else if (m.t === 'error' && m.code !== 'stale') console.info(`[anyworld] room: ${m.code} ${m.message}`);
        return;
      }
      default:
        return;
    }
  }
}

/**
 * The WorldEntry a room's run is launched with (audio and the recordings key read it): the server's
 * world id, and for a demo world the bundled id it came from (matched by title and language).
 */
export function roomWorldEntry(world: WorldSpec, worldId: string, demos: readonly WorldIndexEntry[]): WorldEntry {
  const demo = demos.find((d) => d.meta.title === world.meta.title && (d.meta.language || 'en') === (world.meta.language || 'en'));
  return { id: worldId, world, ...(demo ? { origin: demo.id } : {}) };
}
