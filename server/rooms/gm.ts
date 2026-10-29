/**
 * The game master next to a room (MP4 design §1): one RoomGm per room and run, in one of three
 * modes (decided at each new run, §1.2):
 *
 *   'ai'        the server has a GM provider (gm-config.ts): a GmRunner over an LlmGmDirector in
 *               room mode (party prompt, chat, RoomGmResponse). Never blocks: answers arrive later
 *               through `onAnswer` and the room turns them into gm entries (Room.gmAnswer).
 *   'recorded'  a demo world on a server without a provider: the demo's recordings
 *               (gm:<hook>/<demo>/a<area>), each served once per run, checked for this party and
 *               capped, answered synchronously; a missing or failing one falls back to the offline
 *               director. Deterministic like MP2's offline rooms; only the text differs.
 *   'offline'   the offline director, exactly as MP2 (the room keeps that path itself).
 *
 * Shared by every room (GmServer): the GmPool (provider calls in flight over all rooms; a request
 * that cannot start waits in its room's runner queue, nothing is answered early) and the GmBudget
 * (hourly caps, server-wide and per room). Per room: a circuit breaker (3 failed or timed-out calls
 * in a row put the room on its fallback for 2 minutes). Every clock is the room's scheduler.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldSpec } from '../../src/schema/world';
import { GmResponse, type GmHook } from '../../src/schema/gm';
import type { PlayerId } from '../../src/engine/types';
import { GmRunner, partyCoalesce } from '../../src/gm/runner';
import type { GmContext, GmDirector, GmHookEvent, OfflineGmDirector } from '../../src/gm/offline';
import { capResponse, LlmGmDirector, type HelpLedgerLike, type PartyGmResponse } from '../../src/llm/gm-runtime';
import { gmResponseErrors } from '../../src/llm/gm-checks';
import { gmPurpose } from '../../src/llm/recording-keys';
import { extractJson } from '../../src/llm/structured';
import { parseRecordingsFile, type Recording } from '../../src/llm/mock';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/types';
import type { GmConfig } from '../gm-config';
import type { Scheduler } from './timing';

export type RoomGmMode = 'ai' | 'recorded' | 'offline';

/** room GM answers carry at most this many output tokens (fast models, one short line per moment) */
export const ROOM_GM_MAX_TOKENS = 700;
/** failed or timed-out calls in a row that open a room's breaker */
export const BREAKER_FAILURES = 3;
/** how long an open breaker keeps the room on its fallback */
export const BREAKER_OPEN_MS = 2 * 60_000;
/** answers to these moments are dropped when older than this (wall clock; the moment has passed) */
export const GM_STALE_MS: Partial<Record<GmHook, number>> = { low_hp: 15_000, region_discovered: 15_000, boss_seen: 15_000, chat: 20_000 };
const HOUR_MS = 3_600_000;

/** the mode a room gets for a world (design §1.2): AI with a provider, recordings for a demo without one, else offline */
export function roomGmMode(config: GmConfig | null | undefined, source: { demo: string } | { upload: true }): RoomGmMode {
  if (!config || config.setting === 'off') return 'offline';
  if (config.setting === 'ai' && config.provider) return 'ai';
  return 'demo' in source ? 'recorded' : 'offline';
}

/** whether an answer to `hook` asked at `askedAt` is too old at `now` */
export function gmAnswerStale(hook: GmHook, askedAt: number, now: number): boolean {
  const max = GM_STALE_MS[hook];
  return max !== undefined && now - askedAt > max;
}

/**
 * The GM persona's name, when the persona starts with one ("Old Mags, the ferryman" → "Old Mags"):
 * the part before the first comma, dash or stop, one to three capitalised words. Else null.
 */
export function personaName(persona: string): string | null {
  const head = persona.split(/[,.;:()\u2013\u2014]| - /)[0]!.trim();
  const words = head.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || head.length < 3 || head.length > 40) return null;
  return words.every((w) => /^\p{Lu}/u.test(w)) ? head : null;
}

/** whether a chat line addresses the GM: "@gm", "gm" or "game master" as words, or the persona's name (case-insensitive) */
export function addressesGm(text: string, persona: string): boolean {
  if (/(^|[^\p{L}\p{N}_])gm(?![\p{L}\p{N}_])/iu.test(text) || /(^|[^\p{L}\p{N}_])game\s*master(?![\p{L}\p{N}_])/iu.test(text)) return true;
  const name = personaName(persona);
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

// ---------------------------------------------------------------------------
// Shared by every room
// ---------------------------------------------------------------------------

/** at most `size` provider calls in flight over all rooms; the others wait in order */
export class GmPool {
  private active = 0;
  private waiters: { resolve: (r: (() => void) | null) => void; signal: AbortSignal }[] = [];

  constructor(readonly size: number) {}

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** a slot (resolves with its release), or null when `signal` aborts first */
  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.active < this.size) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const w = { resolve, signal };
      this.waiters.push(w);
      signal.addEventListener(
        'abort',
        () => {
          const i = this.waiters.indexOf(w);
          if (i < 0) return;
          this.waiters.splice(i, 1);
          resolve(null);
        },
        { once: true },
      );
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      while (this.active < this.size && this.waiters.length) {
        const w = this.waiters.shift()!;
        if (w.signal.aborted) continue;
        this.active++;
        w.resolve(this.releaser());
      }
    };
  }
}

/** hourly provider-call caps: server-wide and per room (by room code, so a new run keeps the count) */
export class GmBudget {
  private hour = -1;
  private total = 0;
  private perRoom = new Map<string, number>();

  constructor(
    readonly perHour: number,
    readonly roomPerHour: number,
    private readonly now: () => number,
  ) {}

  private roll(): void {
    const h = Math.floor(this.now() / HOUR_MS);
    if (h === this.hour) return;
    this.hour = h;
    this.total = 0;
    this.perRoom.clear();
  }

  /** whether `room` may make another call this hour */
  allows(room: string): boolean {
    this.roll();
    return this.total < this.perHour && (this.perRoom.get(room) ?? 0) < this.roomPerHour;
  }

  charge(room: string): void {
    this.roll();
    this.total++;
    this.perRoom.set(room, (this.perRoom.get(room) ?? 0) + 1);
  }

  /** calls made this hour (server-wide, or by `room`) */
  used(room?: string): number {
    this.roll();
    return room === undefined ? this.total : (this.perRoom.get(room) ?? 0);
  }
}

/** the GM pieces every room of a server shares */
export class GmServer {
  readonly pool: GmPool;
  readonly budget: GmBudget;
  private readonly recs = new Map<string, Recording[]>();

  constructor(
    readonly config: GmConfig,
    now: () => number,
    private readonly recordingsDir: string | null,
  ) {
    this.pool = new GmPool(Math.max(1, config.concurrency));
    this.budget = new GmBudget(config.callsPerHour, config.roomCallsPerHour, now);
  }

  /** the server's capability (/api/health) */
  get capability(): 'ai' | 'offline' {
    return this.config.setting === 'ai' && this.config.provider ? 'ai' : 'offline';
  }

  /** a demo's recordings (content/recordings/<demo>/*.json), read once and cached; unreadable files are skipped */
  recordings(demo: string): Recording[] {
    const hit = this.recs.get(demo);
    if (hit) return hit;
    const out: Recording[] = [];
    if (this.recordingsDir && /^[a-z0-9][a-z0-9-]*$/.test(demo)) {
      const dir = join(this.recordingsDir, demo);
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      } catch {
        // no recordings for this demo
      }
      for (const f of files) {
        try {
          out.push(...parseRecordingsFile(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
        } catch {
          // (a broken file: its moments use the offline director)
        }
      }
    }
    this.recs.set(demo, out);
    return out;
  }
}

// ---------------------------------------------------------------------------
// One room's GM
// ---------------------------------------------------------------------------

export interface GmAnswer {
  run: number;
  area: number;
  askedAt: number;
  hook: GmHookEvent;
  /** the player the moment was asked for (the answer's `player` may name another member) */
  pid: PlayerId;
  response: PartyGmResponse;
  source: string;
}

export interface RoomGmDeps {
  mode: RoomGmMode;
  /** null: offline (no pool, no budget) */
  server: GmServer | null;
  /** the room code (budget and logs) */
  room: string;
  run: number;
  world: WorldSpec;
  /** the demo id (recordings, and the breaker's fallback), when the world is a demo */
  demo: string | null;
  /** the recordings key of the world (demo id, or worldKeyOf(world)) */
  worldKey: string;
  /** backed by the room's tracker (§1.5) */
  ledger: HelpLedgerLike;
  scheduler: Scheduler;
  /** the room's offline director (the world's language) */
  offline: OfflineGmDirector;
  onAnswer(a: GmAnswer): void;
  log(line: string): void;
}

/** a provider that charges the budget, counts usage and latency, and reports each call */
class MeteredProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  constructor(
    private readonly inner: LLMProvider,
    private readonly gm: RoomGm,
  ) {
    this.id = inner.id;
    this.model = inner.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return this.gm.metered(() => this.inner.complete(req));
  }
}

export class RoomGm {
  readonly mode: RoomGmMode;
  private readonly runner: GmRunner | null = null;
  private readonly director: LlmGmDirector | null = null;
  private readonly pids = new Map<number, { pid: PlayerId; run: number }>();
  private readonly recs = new Map<string, Recording[]>();
  private readonly served = new Map<string, number>();
  private failures = 0;
  private failedNow = false;
  private openUntil: number | null = null;
  private capped = false;
  private stats = { area: -1, calls: 0, inTokens: 0, outTokens: 0, ms: 0 };
  private disposed = false;

  constructor(private readonly deps: RoomGmDeps) {
    this.mode = deps.mode;
    if (deps.demo && deps.server && deps.mode !== 'offline') {
      for (const r of deps.server.recordings(deps.demo)) {
        if (!r.purpose.startsWith('gm:')) continue;
        this.recs.set(r.purpose, [...(this.recs.get(r.purpose) ?? []), r]);
      }
    }
    const provider = deps.server?.config.provider;
    if (deps.mode !== 'ai' || !deps.server || !provider) return;
    const config = deps.server.config;
    const sch = deps.scheduler;
    const setTimer = (fn: () => void, ms: number) => sch.setTimer(sch.now() + ms, fn);
    const clearTimer = (h: unknown) => sch.cancel(h as number);
    const fallback = this.fallbackDirector();
    this.director = new LlmGmDirector({
      provider: new MeteredProvider(provider, this),
      worldKey: deps.worldKey,
      ledger: deps.ledger,
      deadlineMs: config.deadlineMs,
      maxTokens: ROOM_GM_MAX_TOKENS,
      party: true,
      retries: 1,
      setTimer,
      clearTimer,
      fallback,
      onError: (e, hook) => {
        this.failedNow = true;
        deps.log(`gm ${hook}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
      },
    });
    const director = this.director;
    // the breaker sees how each primary call went (an abort by an area change is neither)
    const tracked: GmDirector = {
      name: director.name,
      respond: async (req) => {
        this.failedNow = false;
        try {
          const r = await director.respond(req);
          if (!req.signal.aborted) this.outcome(!this.failedNow);
          return r;
        } catch (e) {
          if (!req.signal.aborted) this.outcome(false);
          throw e;
        }
      },
    };
    this.runner = new GmRunner(tracked, {
      fallback: director.capped(fallback),
      timeoutMs: config.timeoutMs,
      setTimer,
      clearTimer,
      now: () => sch.now(),
      coalesce: partyCoalesce,
      dropStale: (hook, askedAt) => gmAnswerStale(hook.hook, askedAt, sch.now()),
      acquire: (signal) => deps.server!.pool.acquire(signal),
      onResult: (r) => {
        const asked = this.pids.get(r.request.id);
        this.pids.delete(r.request.id);
        if (!asked || this.disposed) return;
        const { id: _id, ...hook } = r.request;
        deps.onAnswer({ run: asked.run, area: hook.area, askedAt: r.askedAt ?? sch.now(), hook, pid: asked.pid, response: r.response as PartyGmResponse, source: r.source });
      },
      onError: (err, req, name) => {
        if (name === director.name) {
          this.outcome(false);
          deps.log(`gm ${req.hook}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
        }
      },
    });
  }

  /** the mode a moment is answered in now: an 'ai' room on its fallback while the breaker is open or a cap is reached */
  current(): RoomGmMode {
    if (this.mode !== 'ai' || this.disposed) return this.mode;
    const now = this.deps.scheduler.now();
    if (this.openUntil !== null) {
      if (now < this.openUntil) return this.fallbackMode();
      this.openUntil = null;
      this.deps.log('gm breaker closed: the AI GM answers again');
    }
    const budget = this.deps.server!.budget;
    const allowed = budget.allows(this.deps.room);
    if (allowed !== !this.capped) {
      this.capped = !allowed;
      this.deps.log(allowed ? 'gm hourly cap: the AI GM answers again' : `gm hourly cap reached (${budget.used()} calls on the server, ${budget.used(this.deps.room)} in this room): fallback until the hour rolls`);
    }
    return allowed ? 'ai' : this.fallbackMode();
  }

  /** the breaker's (and the caps') fallback: recorded lines for a demo, else the offline director */
  private fallbackMode(): RoomGmMode {
    return this.deps.demo ? 'recorded' : 'offline';
  }

  /**
   * One moment for `pid` (ctx: the state from pid's perspective). 'ai' queues it (never blocks);
   * 'recorded' answers synchronously through onAnswer. 'offline' is the room's own path (MP2).
   */
  ask(hook: GmHookEvent, pid: PlayerId, ctx: GmContext, mode: RoomGmMode): void {
    if (this.disposed) return;
    const now = this.deps.scheduler.now();
    if (mode === 'ai' && this.runner) {
      if (this.stats.area !== hook.area) this.flushStats(hook.area);
      const id = this.runner.request(hook, ctx);
      if (id) this.pids.set(id, { pid, run: this.deps.run });
      return;
    }
    if (mode !== 'recorded') return;
    const r = this.recordedRespond(hook, ctx);
    if (r) this.deps.onAnswer({ run: this.deps.run, area: hook.area, askedAt: now, hook, pid, response: r, source: 'recorded' });
  }

  /**
   * A recorded answer (synchronous): the demo's recording of the moment, served once per run,
   * parsed and checked against this party's state (a recording made for one player that fails the
   * checks is not used), capped by the help ceiling; otherwise the offline director's answer.
   */
  recordedRespond(hook: GmHookEvent, ctx: GmContext): GmResponse | null {
    const purpose = gmPurpose(hook.hook, this.deps.worldKey, hook.area);
    const area = purpose.slice(0, purpose.lastIndexOf('/'));
    for (const key of [purpose, area]) {
      const list = this.recs.get(key);
      const i = this.served.get(key) ?? 0;
      if (!list || i >= list.length) continue;
      this.served.set(key, i + 1);
      const rec = list[i]!;
      const ex = extractJson(rec.text ?? JSON.stringify(rec.json ?? null));
      const p = ex.ok ? GmResponse.safeParse(ex.value) : null;
      if (!p?.success) break;
      if (gmResponseErrors(ctx.world, ctx.state, p.data, hook.hook).length) break;
      return capResponse(this.deps.ledger, { hook: hook.hook, ctx }, p.data.actions);
    }
    return this.deps.offline.respondSync({ ...hook, ctx });
  }

  /** the fallback director of an 'ai' room (a demo's recordings, else offline) */
  private fallbackDirector(): GmDirector {
    if (!this.deps.demo) return this.deps.offline;
    return { name: 'recorded', respond: async (req) => this.recordedRespond(req, req.ctx) };
  }

  /** the hooks waiting or running ('ai'; rooms: "a chat request is already queued") */
  pendingHooks(): GmHookEvent[] {
    return this.runner?.pendingHooks() ?? [];
  }

  /** the area changed or the run ended: everything queued or in flight is dropped */
  cancelAll(): void {
    this.runner?.cancelAll();
    this.pids.clear();
    this.flushStats(-1);
  }

  /** the room closes or a new run starts */
  dispose(): void {
    if (this.disposed) return;
    this.flushStats(-1);
    this.disposed = true;
    this.runner?.dispose();
    this.pids.clear();
  }

  /** resolves when nothing is queued, waiting for a slot or running (tests) */
  idle(): Promise<void> {
    return this.runner?.idle() ?? Promise.resolve();
  }

  /** one provider call: charged to the budget, counted for the area's log line */
  async metered<T extends CompletionResponse>(call: () => Promise<T>): Promise<T> {
    const sch = this.deps.scheduler;
    this.deps.server?.budget.charge(this.deps.room);
    const t0 = sch.now();
    this.stats.calls++;
    try {
      const r = await call();
      this.stats.inTokens += r.usage?.inputTokens ?? 0;
      this.stats.outTokens += r.usage?.outputTokens ?? 0;
      return r;
    } finally {
      this.stats.ms += sch.now() - t0;
    }
  }

  private outcome(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      return;
    }
    if (++this.failures < BREAKER_FAILURES || this.openUntil !== null) return;
    this.failures = 0;
    this.openUntil = this.deps.scheduler.now() + BREAKER_OPEN_MS;
    this.deps.log(`gm breaker open: ${BREAKER_FAILURES} failed calls in a row; ${this.fallbackMode()} answers for ${BREAKER_OPEN_MS / 1000} s`);
  }

  /** one log line per area with calls: calls, tokens and the average latency */
  private flushStats(nextArea: number): void {
    const s = this.stats;
    if (s.calls > 0) this.deps.log(`gm area ${s.area}: ${s.calls} calls, ${s.inTokens} in / ${s.outTokens} out tokens, ${Math.round(s.ms / s.calls)} ms average`);
    this.stats = { area: nextArea, calls: 0, inTokens: 0, outTokens: 0, ms: 0 };
  }
}
