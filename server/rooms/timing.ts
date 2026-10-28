/**
 * Every duration the rooms use (MP2 design §4, "Constants") and the clock they run on. Both are
 * injected (startServer({ rooms: { timing, scheduler } }), the child-process tests'
 * ANYWORLD_TEST_TIMING), never set over the protocol. Room-level tests drive a ManualScheduler
 * instead of fake timers, which fight `ws`.
 */

export interface RoomTiming {
  /** a turn where everyone who acted travels or waits resolves this long after the last one */
  travelMs: number;
  /** during an exit countdown, a turn resolves this often whether or not anyone acted */
  countdownTurnMs: number;
  /** longest wait after an area change for every connected seat to report `applied` */
  areaHoldMaxMs: number;
  /** a seat with no input or presence change for this long is idle (does not hold up a turn) */
  idleActiveMs: number;
  /** typing ends without a refresh after this long */
  typingExpiryMs: number;
  /** a seat off this long leaves the map (playing) or loses its seat (lobby) */
  awayMs: number;
  /** a room without input or chat for this long is closed */
  idleCloseMs: number;
  /** how often the manager looks for idle rooms */
  idleSweepMs: number;
  /** the first message (hello) must come within this */
  helloTimeoutMs: number;
  /** `clock` messages are sent at most this often */
  clockThrottleMs: number;
}

export const DEFAULT_TIMING: RoomTiming = {
  travelMs: 100,
  countdownTurnMs: 1000,
  areaHoldMaxMs: 3000,
  idleActiveMs: 10_000,
  typingExpiryMs: 8000,
  awayMs: 120_000,
  idleCloseMs: 2 * 60 * 60_000,
  idleSweepMs: 60_000,
  helloTimeoutMs: 5000,
  clockThrottleMs: 200,
};

/** the defaults with some durations replaced (unknown keys and non-positive numbers are ignored) */
export function roomTiming(partial: Partial<RoomTiming> = {}): RoomTiming {
  const out = { ...DEFAULT_TIMING };
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof RoomTiming)[]) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export type TimerId = number;

/** a clock and one-shot timers at absolute times (ms) */
export interface Scheduler {
  now(): number;
  /** runs `fn` once at `at` (at once if `at` is past, but never synchronously) */
  setTimer(at: number, fn: () => void): TimerId;
  cancel(id: TimerId | null | undefined): void;
}

/** wall clock and setTimeout (timers are unref'ed so they never keep the process alive) */
export class RealScheduler implements Scheduler {
  private next = 1;
  private readonly timers = new Map<TimerId, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  setTimer(at: number, fn: () => void): TimerId {
    const id = this.next++;
    const h = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, Math.max(0, at - Date.now()));
    h.unref?.();
    this.timers.set(id, h);
    return id;
  }

  cancel(id: TimerId | null | undefined): void {
    if (id == null) return;
    const h = this.timers.get(id);
    if (h !== undefined) clearTimeout(h);
    this.timers.delete(id);
  }
}

/** a clock that only moves when told to (tests): advanceTo runs due timers in time order */
export class ManualScheduler implements Scheduler {
  private t: number;
  private next = 1;
  private readonly timers = new Map<TimerId, { at: number; fn: () => void }>();

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(at: number, fn: () => void): TimerId {
    const id = this.next++;
    this.timers.set(id, { at, fn });
    return id;
  }

  cancel(id: TimerId | null | undefined): void {
    if (id != null) this.timers.delete(id);
  }

  /** timers not yet run */
  get pending(): number {
    return this.timers.size;
  }

  /** the earliest timer, or null */
  nextAt(): number | null {
    let best: number | null = null;
    for (const { at } of this.timers.values()) if (best === null || at < best) best = at;
    return best;
  }

  /** moves the clock to `t`, running every timer due by then (also ones set while running), in time then creation order */
  advanceTo(t: number): void {
    for (let guard = 0; guard < 100_000; guard++) {
      let id: TimerId | null = null;
      let at = Infinity;
      // (a Map iterates in insertion order, so on a tie the older timer wins)
      for (const [k, v] of this.timers) if (v.at < at) [id, at] = [k, v.at];
      if (id === null || at > t) break;
      const timer = this.timers.get(id)!;
      this.timers.delete(id);
      this.t = Math.max(this.t, at);
      timer.fn();
    }
    this.t = Math.max(this.t, t);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.t + ms);
  }

  /** runs timers that are already due (at ≤ now) */
  flush(): void {
    this.advanceTo(this.t);
  }
}
