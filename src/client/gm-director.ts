/**
 * The live game master, client side (DESIGN §4.3).
 *
 *  - The director contract, the OFFLINE director, hook detection (`gmHooksFor`, `HookTracker`) and
 *    response helpers live in src/gm/offline.ts (shared with the room server, MP2) and are
 *    re-exported here; the client's OfflineGmDirector labels its offers with the client's i18n.
 *  - `GmRunner` calls a director WITHOUT ever blocking turns: requests are queued, run one at a
 *    time with a timeout, fall back to a second director when the first is slow or fails, and
 *    every result is tagged with the "epoch" it was asked in. Changing area (or ending the run)
 *    bumps the epoch and aborts what is in flight, so a late answer about the previous area is
 *    dropped instead of applied.
 *
 * Results are applied by the controller through GameSession.applyGm → engine applyGmActions, which
 * enforces the GM budget, references and rule limits. Nothing in here touches the DOM.
 */
import type { GmHook, GmResponse } from '../schema/gm';
import { t as tr } from './i18n/index';
import {
  OfflineGmDirector as SharedOfflineGmDirector,
  sanitizeResponse,
  type GmContext,
  type GmDirector,
  type GmHookEvent,
  type OfflineDirectorOptions,
} from '../gm/offline';

export {
  FIRST_IDLE_TURNS,
  IDLE_TURNS,
  drainEngineQueue,
  engineQueuedHooks,
  eventFlag,
  gmHooksFor,
  hashOf,
  isGmActionType,
  narrationOf,
  newHookTracker,
  responseCost,
  saidFlag,
  sanitizeResponse,
  type Difficulty,
  type GmContext,
  type GmDirector,
  type GmHookDetail,
  type GmHookEvent,
  type GmRequest,
  type GmTranslate,
  type HookTracker,
  type OfflineDirectorOptions,
} from '../gm/offline';

/** the offline director with the client's i18n labels (src/gm/offline.ts) */
export class OfflineGmDirector extends SharedOfflineGmDirector {
  constructor(opts: OfflineDirectorOptions = {}) {
    super({ t: tr, ...opts });
  }
}

/** what the runner hands back to the controller */
export interface GmResult {
  request: GmHookEvent & { id: number };
  response: GmResponse;
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
  /** called when a director failed (logging only) */
  onError?: (err: unknown, req: GmHookEvent, director: string) => void;
  /** timer hooks (tests) */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

interface Queued {
  id: number;
  epoch: number;
  hook: GmHookEvent;
  ctx: GmContext;
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

  /** queue a GM moment; returns its request id (never blocks) */
  request(hook: GmHookEvent, ctx: GmContext): number {
    if (this.disposed) return 0;
    const q: Queued = { id: this.nextId++, epoch: this.epoch, hook, ctx };
    this.queue.push(q);
    while (this.queue.length > this.maxQueue) {
      const i = this.queue.findIndex((x) => !KEEP.has(x.hook.hook));
      this.queue.splice(i >= 0 ? i : 0, 1);
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
    this.queue = [];
    this.running?.ctrl.abort();
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
    const q = this.queue.shift();
    if (!q) {
      this.flushIdle();
      return;
    }
    const ctrl = new AbortController();
    this.running = { q, ctrl };
    try {
      const res = await this.ask(q, ctrl);
      if (res && !this.disposed && q.epoch === this.epoch && !ctrl.signal.aborted) {
        this.opts.onResult({ request: { ...q.hook, id: q.id }, response: res.response, source: res.source });
      }
    } finally {
      this.running = null;
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
        if (clean) return { response: clean, source: d.name };
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
