/**
 * The GM runner (DESIGN §4.3), shared by the single-player client and the room server (MP4 design
 * §1.1; moved here from src/client/gm-director.ts, which re-exports it). It calls a director
 * WITHOUT ever blocking turns: requests are queued, run one at a time with a timeout, fall back to a
 * second director when the first is slow or fails, and every result is tagged with the "epoch" it
 * was asked in. Changing area (or ending the run) bumps the epoch and aborts what is in flight, so a
 * late answer about the previous area is dropped instead of applied.
 *
 * Rooms add two options single player does not use: `coalesce` (a queued hook replaced by a newer
 * one about the same thing, so a party never multiplies requests) and `dropStale` (checked when a
 * request is dequeued, before any provider call). No DOM, no i18n.
 */
import type { GmHook, GmResponse } from '../schema/gm';
import { sanitizeResponse, type GmContext, type GmDirector, type GmHookEvent } from './offline';

/** what the runner hands back to the controller */
export interface GmResult {
  request: GmHookEvent & { id: number };
  response: GmResponse;
  /** when the request was queued (the runner's `now`) */
  askedAt?: number;
  /** which director answered (primary or fallback) */
  source: string;
}

// ---------------------------------------------------------------------------
// Runner: async, non-blocking, cancellable
// ---------------------------------------------------------------------------

export interface GmRunnerOptions {
  /** the fallback director used when the primary times out, fails or answers nothing usable */
  fallback?: GmDirector;
  /** per-request time limit for the primary (default 8000 ms); the fallback gets the same */
  timeoutMs?: number;
  /** the queue never holds more than this many waiting requests (oldest idle hooks drop first) */
  maxQueue?: number;
  /** called for every usable result of the current epoch */
  onResult: (r: GmResult) => void;
  /**
   * Called once for every request when it leaves the runner, answered or not: after its result (or
   * its silence, failure or abort), and when it is coalesced, evicted, dropped as stale or cancelled
   * while queued (rooms: request bookkeeping, a chat line owed an answer). Default: none.
   */
  onSettled?: (id: number, hook: GmHookEvent, askedAt: number) => void;
  /** called when a director failed (logging only) */
  onError?: (err: unknown, req: GmHookEvent, director: string) => void;
  /** timer hooks (tests, the room's scheduler) */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** the clock for `askedAt` and `dropStale` (default Date.now) */
  now?: () => number;
  /**
   * true when the newer hook `b` replaces the queued (not yet running) hook `a`: the queued one is
   * dropped and `b` takes its place in the queue (rooms: partyCoalesce). Default: never.
   */
  coalesce?: (a: GmHookEvent, b: GmHookEvent) => boolean;
  /** true when a request is too old to ask any more; checked when it is dequeued (default: never) */
  dropStale?: (hook: GmHookEvent, askedAt: number) => boolean;
  /**
   * A slot to run a dequeued request in (rooms: the server-wide GmPool); resolves with its release,
   * or null when `signal` aborted while waiting. The request keeps its place as the running one, so
   * newer hooks wait (and coalesce) in the queue; the timeout starts once the slot is held, and
   * `dropStale` is checked again after the wait. Default: no gate.
   */
  acquire?: (signal: AbortSignal) => Promise<(() => void) | null>;
}

interface Queued {
  id: number;
  epoch: number;
  hook: GmHookEvent;
  ctx: GmContext;
  at: number;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`GM timed out after ${ms} ms`);
  }
}

/** hooks that are never dropped when the queue is full */
const KEEP: ReadonlySet<GmHook> = new Set(['intro', 'area_enter', 'death', 'victory']);

export class GmRunner {
  private queue: Queued[] = [];
  private running: { q: Queued; ctrl: AbortController } | null = null;
  private epoch = 0;
  private nextId = 1;
  private disposed = false;
  private idleWaiters: (() => void)[] = [];
  private readonly timeoutMs: number;
  private readonly maxQueue: number;

  constructor(
    private director: GmDirector,
    private opts: GmRunnerOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxQueue = opts.maxQueue ?? 4;
  }

  /** swap the primary director (settings changed); pending requests keep running */
  setDirector(d: GmDirector): void {
    this.director = d;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /** number of requests waiting or running */
  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** the hooks waiting or running, running first (rooms: "a chat request is already queued") */
  pendingHooks(): GmHookEvent[] {
    return [...(this.running ? [this.running.q.hook] : []), ...this.queue.map((q) => q.hook)];
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** queue a GM moment; returns its request id (never blocks) */
  request(hook: GmHookEvent, ctx: GmContext): number {
    if (this.disposed) return 0;
    const q: Queued = { id: this.nextId++, epoch: this.epoch, hook, ctx, at: this.now() };
    const co = this.opts.coalesce;
    const same = co ? this.queue.findIndex((x) => co(x.hook, hook)) : -1;
    if (same >= 0) this.settled(this.queue.splice(same, 1, q));
    else this.queue.push(q);
    while (this.queue.length > this.maxQueue) {
      const i = this.queue.findIndex((x) => !KEEP.has(x.hook.hook));
      this.settled(this.queue.splice(i >= 0 ? i : 0, 1));
    }
    void this.pump();
    return q.id;
  }

  /**
   * Drop everything queued and abort what is running: the area changed (or the run ended), so
   * answers about the old situation would be stale.
   */
  cancelAll(): void {
    this.epoch++;
    this.settled(this.queue.splice(0));
    this.running?.ctrl.abort();
  }

  private settled(qs: readonly Queued[]): void {
    for (const q of qs) this.opts.onSettled?.(q.id, q.hook, q.at);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.flushIdle();
  }

  /** resolves when the queue is empty and nothing runs (tests, e2e) */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private flushIdle(): void {
    const w = this.idleWaiters.splice(0);
    for (const r of w) r();
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    let q = this.queue.shift();
    const stale = this.opts.dropStale;
    while (q && stale?.(q.hook, q.at)) {
      this.settled([q]);
      q = this.queue.shift();
    }
    if (!q) {
      this.flushIdle();
      return;
    }
    const ctrl = new AbortController();
    this.running = { q, ctrl };
    let release: (() => void) | null = null;
    try {
      if (this.opts.acquire) {
        release = await this.opts.acquire(ctrl.signal);
        // (waited for a slot: the area may have changed or the moment passed meanwhile)
        if (!release || ctrl.signal.aborted || this.disposed || q.epoch !== this.epoch || stale?.(q.hook, q.at)) return;
      }
      const res = await this.ask(q, ctrl);
      if (res && !this.disposed && q.epoch === this.epoch && !ctrl.signal.aborted) {
        this.opts.onResult({ request: { ...q.hook, id: q.id }, response: res.response, source: res.source, askedAt: q.at });
      }
    } finally {
      release?.();
      this.running = null;
      this.settled([q]);
      if (this.queue.length) void this.pump();
      else this.flushIdle();
    }
  }

  private async ask(q: Queued, ctrl: AbortController): Promise<{ response: GmResponse; source: string } | null> {
    const directors = [this.director, ...(this.opts.fallback && this.opts.fallback !== this.director ? [this.opts.fallback] : [])];
    for (const d of directors) {
      if (ctrl.signal.aborted || q.epoch !== this.epoch) return null;
      try {
        const r = await this.withTimeout(d, q, ctrl);
        if (ctrl.signal.aborted || q.epoch !== this.epoch) return null;
        const clean = sanitizeResponse(r);
        // (a room answer's target, PartyGmResponse.player, survives the clean-up; single player never has one)
        const player = (r as { player?: unknown } | null)?.player;
        if (clean) return { response: typeof player === 'string' ? ({ ...clean, player } as GmResponse) : clean, source: d.name };
        if (r === null) return null; // "nothing to add" is an answer, not a failure
      } catch (err) {
        if (ctrl.signal.aborted && !(err instanceof TimeoutError)) return null;
        this.opts.onError?.(err, q.hook, d.name);
      }
    }
    return null;
  }

  private withTimeout(d: GmDirector, q: Queued, outer: AbortController): Promise<GmResponse | null> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    outer.signal.addEventListener('abort', onAbort, { once: true });
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    return new Promise<GmResponse | null>((resolve, reject) => {
      let done = false;
      const timer = set(() => {
        if (done) return;
        done = true;
        ctrl.abort();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clear(timer);
        outer.signal.removeEventListener('abort', onAbort);
        fn();
      };
      outer.signal.addEventListener('abort', () => finish(() => resolve(null)), { once: true });
      let p: Promise<GmResponse | null>;
      try {
        p = Promise.resolve(d.respond({ ...q.hook, id: q.id, ctx: q.ctx, signal: ctrl.signal }));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (r) => finish(() => resolve(r)),
        (e) => finish(() => reject(e)),
      );
    });
  }
}

/**
 * The rooms' coalescing rule (MP4 design §2.2): a newer hook of the same kind about the same player
 * replaces a queued one; `low_hp` is one per party (the newest wins). Hooks that are never dropped
 * (intro, area_enter, death, victory) are never coalesced either.
 */
export function partyCoalesce(a: GmHookEvent, b: GmHookEvent): boolean {
  if (a.hook !== b.hook || KEEP.has(a.hook)) return false;
  if (a.hook === 'low_hp') return true;
  return (a.detail?.playerId ?? null) === (b.detail?.playerId ?? null);
}
