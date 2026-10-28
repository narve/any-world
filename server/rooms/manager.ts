/**
 * All rooms of a server (MP2 design §3, §7): create (room limits, a demo or an uploaded world),
 * list, find, hello (version, tombstone and room checks before the room sees it), the idle sweep,
 * load at start-up (with version closing) and shutdown. The engine version is a constructor
 * argument (main() computes it once; tests pass their own).
 */
import { randomInt } from 'node:crypto';
import type { WorldSpec } from '../../src/schema/world';
import { unregisterWorld, worldIdOf } from '../../src/engine/index';
import { LIMITS, REFUSED_CLOSE, type ClosedReason, type Hello, type Refused, type RoomInfo, type RoomOptions } from '../../src/net/protocol';
import { refused, Room, type Conn, type RoomDeps, type RoomWorld } from './room';
import { RoomStore, type Tombstone } from './store';
import { DEFAULT_TIMING, RealScheduler, roomTiming, type RoomTiming, type Scheduler, type TimerId } from './timing';
import { DemoWorlds } from './worlds';

/** room code characters (Code in protocol.ts: no 0, 1, I or O) */
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface ManagerOptions {
  /** <data dir>/rooms */
  dir: string;
  engineVersion: string;
  timing?: Partial<RoomTiming>;
  scheduler?: Scheduler;
  demos?: DemoWorlds;
  /** open rooms at most (default LIMITS.maxRooms; createApp passes env ANYWORLD_MAX_ROOMS) */
  maxRooms?: number;
  log?: (line: string) => void;
  /** seeds, tokens and room codes (tests) */
  seed?: () => number;
  token?: () => string;
  code?: () => string;
}

export interface CreateRoom {
  /** a demo file id in content/worlds, or */
  demo?: string;
  /** an uploaded world, already validated with parseWorld (strict keys) */
  world?: WorldSpec;
  options?: Partial<RoomOptions>;
  /** the creator's name for the host seat until its hello (default 'Host') */
  name?: string;
}

export type CreateResult = { ok: true; code: string; token: string; room: Room } | { ok: false; error: 'server_full' | 'no_demo' };

export interface LoadReport {
  loaded: string[];
  /** closed because their engine version differs (server_updated) */
  closed: string[];
  /** unreadable: moved to rooms/broken/ */
  broken: string[];
  tmpRemoved: number;
}

function newCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

export class RoomManager {
  readonly engineVersion: string;
  readonly timing: RoomTiming;
  readonly scheduler: Scheduler;
  readonly store: RoomStore;
  readonly demos: DemoWorlds;
  readonly maxRooms: number;
  private readonly rooms = new Map<string, Room>();
  private tombs: Record<string, Tombstone> = {};
  private sweepTimer: TimerId | null = null;
  private readonly logFn: (line: string) => void;

  constructor(private readonly opts: ManagerOptions) {
    this.engineVersion = opts.engineVersion;
    this.timing = roomTiming(opts.timing ?? DEFAULT_TIMING);
    this.scheduler = opts.scheduler ?? new RealScheduler();
    this.store = new RoomStore(opts.dir);
    this.demos = opts.demos ?? new DemoWorlds();
    this.maxRooms = opts.maxRooms ?? LIMITS.maxRooms;
    this.logFn = opts.log ?? console.log;
  }

  private deps(): RoomDeps {
    return {
      timing: this.timing,
      scheduler: this.scheduler,
      store: this.store,
      demos: this.demos,
      log: this.logFn,
      onClose: (room, reason) => this.onClosed(room, reason),
      releaseWorld: (id) => this.releaseWorld(id),
      ...(this.opts.seed ? { seed: this.opts.seed } : {}),
      ...(this.opts.token ? { token: this.opts.token } : {}),
    };
  }

  private log(line: string): void {
    this.logFn(`[rooms] ${line}`);
  }

  /**
   * Start-up: leftover *.tmp files are deleted, then every stored room is read. A room of another
   * engine version is closed (files removed, tombstone server_updated); an unreadable one is moved
   * to rooms/broken/ (never fatal); the others are replayed and sleep until a seat reconnects.
   */
  load(): LoadReport {
    const now = this.scheduler.now();
    const report: LoadReport = { loaded: [], closed: [], broken: [], tmpRemoved: this.store.cleanTmp() };
    this.tombs = this.store.tombstones(now);
    const add: Record<string, Tombstone> = {};
    for (const code of this.store.codes()) {
      try {
        const loaded = this.store.load(code);
        if (loaded.room.engineVersion !== this.engineVersion) {
          this.store.remove(code);
          add[code] = { reason: 'server_updated', at: now };
          report.closed.push(code);
          this.log(`room ${code} closed: engine ${loaded.room.engineVersion} → ${this.engineVersion}`);
          continue;
        }
        const room = Room.load(loaded, this.deps());
        this.rooms.set(code, room);
        report.loaded.push(code);
      } catch (e) {
        this.log(`room ${code} is broken (${e instanceof Error ? e.message : String(e)}); moved to rooms/broken/`);
        try {
          this.store.moveBroken(code);
        } catch {
          // (the next start tries again)
        }
        report.broken.push(code);
      }
    }
    if (Object.keys(add).length || Object.keys(this.tombs).length) this.tombs = this.store.addTombstones(add, now);
    if (report.loaded.length) this.log(`loaded ${report.loaded.length} room(s): ${report.loaded.join(', ')}`);
    return report;
  }

  /** starts the idle sweep (every timing.idleSweepMs) */
  start(): void {
    if (this.sweepTimer !== null) return;
    const tick = () => {
      this.sweepTimer = this.scheduler.setTimer(this.scheduler.now() + this.timing.idleSweepMs, () => {
        this.sweep();
        tick();
      });
    };
    tick();
  }

  /**
   * Closes rooms without input or chat for timing.idleCloseMs, and lobbies nobody has been connected
   * to for timing.awayMs (a creator who never connects, or a lobby everyone left: its seats would be
   * removed by the 2-minute rule anyway, and an unclaimed room must not hold a place for 2 hours).
   */
  sweep(): void {
    const now = this.scheduler.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivityAt >= this.timing.idleCloseMs) room.close('idle');
      else if (room.phase === 'lobby' && room.emptySince !== null && now - room.emptySince >= this.timing.awayMs) room.close('empty');
    }
  }

  get size(): number {
    return this.rooms.size;
  }

  /** a new room in the lobby with the creator's (host) seat */
  create(req: CreateRoom): CreateResult {
    if (this.rooms.size >= this.maxRooms) return { ok: false, error: 'server_full' };
    let world: RoomWorld;
    if (req.world) {
      world = { world: req.world, worldId: worldIdOf(req.world), source: { upload: true } };
    } else {
      const d = req.demo !== undefined ? this.demos.get(req.demo) : null;
      if (!d) return { ok: false, error: 'no_demo' };
      world = { world: d.world, worldId: d.worldId, source: { demo: d.id } };
    }
    const options: RoomOptions = {
      maxPlayers: req.options?.maxPlayers ?? LIMITS.maxPlayers.default,
      deadlineMs: req.options?.deadlineMs ?? LIMITS.deadlineMs.default,
      difficulty: req.options?.difficulty ?? 'normal',
    };
    const code = this.freeCode();
    const room = Room.create(code, world, options, this.engineVersion, this.deps());
    this.rooms.set(code, room);
    const seat = room.addSeat(req.name)!;
    this.log(`room ${code} created (${world.worldId}, ${'demo' in world.source ? `demo ${world.source.demo}` : 'upload'})`);
    return { ok: true, code, token: seat.token, room };
  }

  private freeCode(): string {
    for (let i = 0; i < 1000; i++) {
      const c = (this.opts.code ?? newCode)();
      if (!this.rooms.has(c) && !this.tombs[c]) return c;
    }
    throw new Error('no free room code');
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** open rooms, newest first */
  list(): RoomInfo[] {
    return [...this.rooms.values()].sort((a, b) => b.createdAt - a.createdAt || (a.code < b.code ? -1 : 1)).map((r) => r.info());
  }

  /** the tombstone of a closed room, if any */
  tombstone(code: string): Tombstone | undefined {
    return this.tombs[code];
  }

  /**
   * A parsed hello (the socket layer answers an outdated engine before parsing, with peekHello; it
   * is checked again here). Refusals are sent and the connection closed with REFUSED_CLOSE; on
   * success the room has sent welcome and the connection belongs to the returned room.
   */
  hello(conn: Conn, h: Hello): Room | null {
    let r: Refused | null = null;
    let room: Room | undefined;
    if (h.engine !== this.engineVersion) r = { ...refused('outdated', 'This page is out of date. Reload it to play.'), reload: true };
    else {
      room = this.rooms.get(h.room);
      const tomb = this.tombs[h.room];
      if (!room && tomb) r = refused('room_closed', 'This room is closed.', tomb.reason);
      else if (!room) r = refused('no_room', 'There is no room with that code.');
      else r = room.hello(conn, h);
    }
    if (r) {
      try {
        conn.send(r);
        conn.close(REFUSED_CLOSE[r.code], r.code);
      } catch {
        // already gone
      }
      return null;
    }
    return room ?? null;
  }

  private onClosed(room: Room, reason: ClosedReason): void {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    const now = this.scheduler.now();
    try {
      this.store.remove(room.code);
      this.tombs = this.store.addTombstones({ [room.code]: { reason, at: now } }, now);
    } catch (e) {
      this.log(`room ${room.code}: removing its files failed: ${String(e)}`);
      this.tombs = { ...this.tombs, [room.code]: { reason, at: now } };
    }
    this.releaseWorld(room.world.worldId);
  }

  /** an uploaded world nobody plays (or has staged for the next run) any more leaves the engine registry (demo worlds stay) */
  releaseWorld(worldId: string): void {
    for (const r of this.rooms.values()) if (!r.closed && (r.world.worldId === worldId || r.nextWorldId === worldId)) return;
    for (const id of this.demos.loadedWorldIds()) if (id === worldId) return;
    unregisterWorld(worldId);
  }

  /** graceful shutdown: every room snapshots and every connection gets `bye`; the sweep stops */
  shutdown(): void {
    this.scheduler.cancel(this.sweepTimer);
    this.sweepTimer = null;
    for (const room of this.rooms.values()) room.shutdown();
  }

  /** closes every room with `reason` (tests; a deploy closes rooms at the next start instead) */
  closeAll(reason: ClosedReason): void {
    for (const room of [...this.rooms.values()]) room.close(reason);
  }
}
