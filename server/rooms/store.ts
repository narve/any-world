/**
 * A room's files (MP2 design §7), all under <data dir>/rooms and written only by the room:
 *
 *  - <code>.world.json  the world, written when it changes (a new room, a new world for "play again")
 *  - <code>.json        the small part: options, phase, seats, chat and the last snapshot; rewritten
 *                       (atomically: *.tmp, fsync, rename) at every snapshot
 *  - <code>.log         newline-delimited JSON appended since that snapshot: entries, seat records and
 *                       chat lines, one appendFileSync per line (a kill -9 cannot cut a line; only a
 *                       power loss can tear the last one, which load skips)
 *  - closed.json        tombstones { [code]: { reason, at } } so a token for a closed room gets
 *                       room_closed instead of no_room; pruned after 7 days
 *
 * A snapshot rewrites <code>.json and then truncates the log; a crash between the two leaves log
 * lines the snapshot already holds, which load skips (by run and n, seat records last-wins, chat by id).
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldSpec } from '../../src/schema/world';
import type { PlayerId } from '../../src/engine/types';
import type { HookTracker } from '../../src/gm/offline';
import type { ChatLine, ClosedReason, LogEntry, Phase, RoomOptions } from '../../src/net/protocol';

export const FILE_FORMAT = 1;
/** tombstones are kept this long */
export const TOMBSTONE_MS = 7 * 24 * 60 * 60_000;

/** rooms/<code>.world.json */
export interface WorldFile {
  format: 1;
  worldId: string;
  world: WorldSpec;
  source: { demo: string } | { upload: true };
}

export interface SeatRecord {
  seat: string;
  tokenHash: string;
  name: string;
  colour: string;
  pid: PlayerId | null;
  joinedAt: number;
  /** the seat sent `leave` (it may still come back with its token) */
  left?: boolean;
  /** the seat was removed (a lobby seat off for 2 minutes, or not kept for a new run) */
  removed?: boolean;
}

/** rooms/<code>.json */
export interface RoomFile {
  format: 1;
  code: string;
  engineVersion: string;
  createdAt: number;
  updatedAt: number;
  options: RoomOptions;
  phase: Phase;
  run: number;
  seed: number;
  /** the host's seat id */
  host: string | null;
  /** the next seat number (seat ids are never reused) */
  nextSeat?: number;
  seats: SeatRecord[];
  /** serialize() of the state after `n` entries of `run` (null in a lobby) */
  snapshot: { n: number; state: string } | null;
  /** the GM hook tracker as of the snapshot (replay rebuilds it over the log) */
  hooks: HookTracker | null;
  chat: ChatLine[];
}

export type LogLine = { e: LogEntry } | { seat: SeatRecord } | { chat: ChatLine };

export interface Tombstone {
  reason: ClosedReason;
  at: number;
}

export interface LoadedRoom {
  room: RoomFile;
  world: WorldFile;
  /** the log, in order; a torn or unreadable line ends it */
  lines: LogLine[];
}

/** writes `text` to `path` atomically: a *.tmp next to it, fsync, rename */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export class RoomStore {
  /** `dir` is <data dir>/rooms; it is created if missing */
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(code: string, ext: '.json' | '.world.json' | '.log'): string {
    return join(this.dir, `${code}${ext}`);
  }

  writeWorld(code: string, file: WorldFile): void {
    writeAtomic(this.path(code, '.world.json'), JSON.stringify(file));
  }

  /** rewrites <code>.json; with `truncate` (a snapshot) the log is emptied afterwards */
  writeRoom(file: RoomFile, truncate: boolean): void {
    writeAtomic(this.path(file.code, '.json'), JSON.stringify(file));
    if (truncate) writeAtomic(this.path(file.code, '.log'), '');
  }

  append(code: string, line: LogLine): void {
    appendFileSync(this.path(code, '.log'), `${JSON.stringify(line)}\n`);
  }

  /** codes of the stored rooms (every <code>.json except closed.json) */
  codes(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.world.json') && f !== 'closed.json')
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  /** a stored room; throws when a file is missing, unreadable or of another format */
  load(code: string): LoadedRoom {
    const room = JSON.parse(readFileSync(this.path(code, '.json'), 'utf8')) as RoomFile;
    if (!room || room.format !== FILE_FORMAT || room.code !== code) throw new Error('unknown room file format');
    const world = JSON.parse(readFileSync(this.path(code, '.world.json'), 'utf8')) as WorldFile;
    if (!world || world.format !== FILE_FORMAT) throw new Error('unknown world file format');
    const lines: LogLine[] = [];
    const logPath = this.path(code, '.log');
    if (existsSync(logPath)) {
      for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.parse(raw) as LogLine);
        } catch {
          break; // a torn last line (power loss): the rest is gone
        }
      }
    }
    return { room, world, lines };
  }

  remove(code: string): void {
    for (const ext of ['.json', '.world.json', '.log'] as const) rmSync(this.path(code, ext), { force: true });
  }

  /** moves a room's files to rooms/broken/ (never fatal: the room is just not loaded) */
  moveBroken(code: string): void {
    const to = join(this.dir, 'broken');
    mkdirSync(to, { recursive: true });
    for (const ext of ['.json', '.world.json', '.log'] as const) {
      const p = this.path(code, ext);
      if (existsSync(p)) renameSync(p, join(to, `${code}${ext}`));
    }
  }

  /** deletes leftover *.tmp files (a crash during an atomic write); returns how many */
  cleanTmp(): number {
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.tmp')) continue;
      rmSync(join(this.dir, f), { force: true });
      n++;
    }
    return n;
  }

  /** the tombstones younger than TOMBSTONE_MS */
  tombstones(now: number): Record<string, Tombstone> {
    let all: Record<string, Tombstone> = {};
    try {
      const v = JSON.parse(readFileSync(join(this.dir, 'closed.json'), 'utf8')) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) all = v as Record<string, Tombstone>;
    } catch {
      // missing or unreadable: no tombstones
    }
    const out: Record<string, Tombstone> = {};
    for (const [code, t] of Object.entries(all)) if (t && typeof t.at === 'number' && now - t.at < TOMBSTONE_MS) out[code] = t;
    return out;
  }

  /** adds tombstones (and prunes old ones), atomically */
  addTombstones(add: Record<string, Tombstone>, now: number): Record<string, Tombstone> {
    const all = { ...this.tombstones(now), ...add };
    writeAtomic(join(this.dir, 'closed.json'), JSON.stringify(all));
    return all;
  }
}

/**
 * The log lines a load replays, in order: entries of the room file's run after its snapshot (an
 * entry already in the snapshot, of another run, or out of sequence is skipped), the last record of
 * each seat, and chat lines not yet in the room file.
 */
export function linesToReplay(room: RoomFile, lines: readonly LogLine[]): { entries: LogEntry[]; seats: SeatRecord[]; chat: ChatLine[] } {
  const entries: LogEntry[] = [];
  let next = room.snapshot?.n ?? 0;
  const seats = new Map<string, SeatRecord>(room.seats.map((s) => [s.seat, s]));
  const chatIds = new Set(room.chat.map((c) => c.id));
  const chat: ChatLine[] = [];
  for (const l of lines) {
    if ('e' in l) {
      if (l.e.run !== room.run || l.e.n !== next) continue;
      entries.push(l.e);
      next++;
    } else if ('seat' in l) {
      seats.set(l.seat.seat, l.seat);
    } else if ('chat' in l && !chatIds.has(l.chat.id)) {
      chatIds.add(l.chat.id);
      chat.push(l.chat);
    }
  }
  return { entries, seats: [...seats.values()], chat };
}
