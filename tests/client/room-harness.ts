/**
 * An in-memory room for client tests (MP3 design §7): real server/rooms Room instances (through a
 * RoomManager with the manual scheduler, test timing and fixed seeds) connected to real RoomClients
 * through an in-memory socket pair: the Conn interface on the server side, RoomSocket on the client
 * side, every frame passed as a JSON string and delivered on queueMicrotask. So the tests run the
 * true protocol without ports. The socket layer's rate buckets are not modelled.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomManager } from '../../server/rooms/manager';
import type { Conn, Room } from '../../server/rooms/room';
import { ManualScheduler, type RoomTiming } from '../../server/rooms/timing';
import { RoomClient, type RoomSocket } from '../../src/net/client';
import { parseClientMsg, PLAYER_COLOURS, type ClientMsg, type RoomOptions, type ServerMsg } from '../../src/net/protocol';
import type { GameState } from '../../src/engine/types';

export const ENGINE = 'v-test';

/** room timing for client tests: quick travel and countdown turns, no idle surprises */
export const TEST_TIMING: Partial<RoomTiming> = { travelMs: 30, countdownTurnMs: 150, idleActiveMs: 600_000, areaHoldMaxMs: 500 };

/** one in-memory connection: the client's socket and the server's Conn */
class MemPipe {
  readonly socket: Omit<RoomSocket, 'readyState'> & { readyState: number; sent: ClientMsg[] };
  readonly conn: Conn;
  private room: Room | null = null;
  private closed = false;

  constructor(private readonly h: MemRoom) {
    const pipe = this;
    const sent: ClientMsg[] = [];
    const socket = {
      readyState: 0,
      sent,
      onopen: null as RoomSocket['onopen'],
      onmessage: null as RoomSocket['onmessage'],
      onclose: null as RoomSocket['onclose'],
      onerror: null as RoomSocket['onerror'],
      send(data: string) {
        if (socket.readyState !== 1) return;
        const msg = parseClientMsg(data);
        if (msg) sent.push(msg);
        pipe.h.queue(() => pipe.serverReceive(data));
      },
      close(code = 1000) {
        pipe.shut(code);
      },
    };
    this.socket = socket;
    this.conn = {
      send(msg: ServerMsg) {
        if (pipe.closed) return;
        const data = JSON.stringify(msg);
        pipe.h.queue(() => {
          if (!pipe.closed) socket.onmessage?.({ data });
        });
      },
      close(code: number) {
        pipe.shut(code);
      },
    };
    h.queue(() => {
      if (this.closed) return;
      socket.readyState = 1;
      socket.onopen?.({});
    });
  }

  /** either side closed: the client's onclose and the room's disconnect follow (as ws's close event) */
  private shut(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.readyState = 3;
    this.h.queue(() => {
      this.socket.onclose?.({ code });
      const room = this.room;
      this.room = null;
      room?.disconnect(this.conn);
    });
  }

  private serverReceive(data: string): void {
    if (this.closed) return;
    const msg = parseClientMsg(data);
    if (!msg) return;
    if (!this.room) {
      if (msg.t === 'hello') this.room = this.h.manager.hello(this.conn, msg);
      return;
    }
    if (!this.room.closed) this.room.message(this.conn, msg);
  }
}

export interface MemRoomOptions {
  demo?: string;
  /** the first run's seed (each later run takes the next) */
  seed?: number;
  timing?: Partial<RoomTiming>;
  options?: Partial<RoomOptions>;
}

export class MemRoom {
  readonly sch = new ManualScheduler();
  readonly manager: RoomManager;
  readonly code: string;
  /** the creator's (host) seat token */
  readonly hostToken: string;
  readonly logs: string[] = [];
  private readonly dir: string;
  private inflight = 0;
  private pipes = new Map<RoomClient, MemPipe[]>();

  constructor(o: MemRoomOptions = {}) {
    this.dir = mkdtempSync(join(tmpdir(), 'anyworld-memroom-'));
    let seed = (o.seed ?? 7) - 1;
    this.manager = new RoomManager({
      dir: this.dir,
      engineVersion: ENGINE,
      scheduler: this.sch,
      timing: { ...TEST_TIMING, ...o.timing },
      log: (l) => this.logs.push(l),
      seed: () => ++seed,
    });
    const created = this.manager.create({ demo: o.demo ?? 'fixture-western', options: o.options ?? {} });
    if (!created.ok) throw new Error(created.error);
    this.code = created.code;
    this.hostToken = created.token;
  }

  get room(): Room {
    return this.manager.get(this.code)!;
  }

  /** a frame in flight (delivered on a microtask) */
  queue(fn: () => void): void {
    this.inflight++;
    queueMicrotask(() => {
      this.inflight--;
      fn();
    });
  }

  /** a RoomClient on an in-memory socket (the first one created with `host: true` takes the creator's token) */
  client(name: string, o: { colour?: (typeof PLAYER_COLOURS)[number]; host?: boolean; token?: string } = {}): RoomClient {
    const c: RoomClient = new RoomClient({
      url: 'mem://room',
      socket: () => {
        const p = new MemPipe(this);
        this.pipes.set(c, [...(this.pipes.get(c) ?? []), p]);
        return p.socket;
      },
      engine: ENGINE,
      room: this.code,
      name,
      colour: o.colour ?? PLAYER_COLOURS[this.pipes.size % PLAYER_COLOURS.length],
      ...(o.host ? { token: this.hostToken } : o.token ? { token: o.token } : {}),
      backoffMs: { min: 50, max: 50 },
      setTimer: (fn, ms) => this.sch.setTimer(this.sch.now() + ms, fn),
      clearTimer: (h) => this.sch.cancel(h as number),
    });
    this.pipes.set(c, []);
    return c;
  }

  /** every message a client sent (all its sockets), oldest first */
  sent(c: RoomClient): ClientMsg[] {
    return (this.pipes.get(c) ?? []).flatMap((p) => p.socket.sent);
  }

  inputs(c: RoomClient): Extract<ClientMsg, { t: 'input' }>[] {
    return this.sent(c).filter((m): m is Extract<ClientMsg, { t: 'input' }> => m.t === 'input');
  }

  /** delivers every frame in flight (and the ones they cause) */
  async flush(): Promise<void> {
    for (let i = 0; i < 1000 && this.inflight > 0; i++) await new Promise((r) => setImmediate(r));
    if (this.inflight > 0) throw new Error('frames still in flight');
  }

  /** moves the room clock (timers run) and delivers what follows */
  async advance(ms: number): Promise<void> {
    await this.flush();
    this.sch.advanceBy(ms);
    await this.flush();
  }

  /** connects clients in order (the first with the host token) and waits for their welcomes */
  async join(...clients: RoomClient[]): Promise<void> {
    for (const c of clients) {
      c.connect();
      await this.flush();
      if (c.status !== 'joined') throw new Error(`${c.opts.name} did not join: ${c.status}`);
    }
  }

  /**
   * Replaces the server's game state (test set-ups: a small map, actors placed) and makes every
   * given client fetch it as a welcome snapshot (its replica is dropped, it reconnects without lastN).
   */
  async craft(fn: (s: GameState) => GameState, clients: RoomClient[]): Promise<void> {
    this.room.state = fn(this.room.state!);
    for (const c of clients) {
      c.state = null;
      c.drop();
    }
    await this.advance(60);
  }

  dispose(): void {
    for (const c of this.pipes.keys()) c.stop();
    this.manager.closeAll('idle');
    rmSync(this.dir, { recursive: true, force: true });
  }
}
