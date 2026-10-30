/**
 * MockProvider: replays recorded responses (tests, demo/offline play) and injects latency and
 * failures so callers can be tested for graceful degradation.
 *
 * Lookup order for a request with purpose "gm:area_enter" and request hash H:
 *   1. "gm:area_enter#H"   (exact recording)
 *   2. "gm:area_enter"     (any recording for this purpose)
 *   3. "gm"                (purpose prefix before ":"; disable with matchPrefix:false)
 *   4. fallback(req)       (generator hook)
 *   5. LLMInvalidResponseError "no recording"
 * Scoped purposes (M3 recordings, see recording-keys.ts) carry "/"-separated segments, e.g.
 * "gm:area_enter/fixture-ship/a1": after the exact key the lookup drops one trailing segment at a
 * time ("gm:area_enter/fixture-ship"), then tries the bare purpose ("gm:area_enter") and its prefix.
 * Several responses under one key are served in order; the last one repeats (repeatLast: false
 * makes an exhausted key fall through instead, so demo mode answers each recorded moment once).
 * Browser-safe; load content/recordings in Node with `loadRecordingsFromDir` (recordings-node.ts).
 */
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types';
import {
  LLMAbortedError,
  LLMInvalidResponseError,
  LLMNetworkError,
  LLMRateLimitError,
  LLMRefusalError,
  LLMServerError,
  LLMTimeoutError,
  type LLMError,
} from './errors';
import { requestHash } from './hash';

export interface Recording {
  purpose: string;
  /** requestHash(req); omit to match any request with this purpose */
  hash?: string;
  /** raw response text … */
  text?: string;
  /** … or a JSON value that is serialised as the response text */
  json?: unknown;
  model?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type MockResponseValue = string | Omit<Recording, 'purpose' | 'hash'>;

export type MockFailureMode =
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'refusal'
  | 'invalid_json'
  | 'empty';

export interface MockFailureOptions {
  mode: MockFailureMode;
  /** fail the first N calls (counted per provider), then behave normally */
  failFirst?: number;
  /** otherwise fail with this probability (0..1), seeded and deterministic */
  probability?: number;
  /** only inject for these purposes (exact or prefix before ":") */
  purposes?: string[];
  seed?: number;
  /** retry-after for rate_limit failures; default 1000 */
  retryAfterMs?: number;
}

export interface MockProviderOptions {
  recordings?: Recording[];
  /** shorthand map: key "purpose" or "purpose#hash" -> response(s) */
  responses?: Record<string, MockResponseValue | MockResponseValue[]>;
  /** generator used when nothing is recorded; return undefined to fall through to "no recording" */
  fallback?: (
    req: CompletionRequest,
  ) => string | CompletionResponse | undefined | Promise<string | CompletionResponse | undefined>;
  /** fixed latency, or [min, max] uniformly drawn from the seeded generator */
  latencyMs?: number | [number, number];
  failure?: MockFailureOptions;
  /** seed of the generator behind latency and failure draws (default failure.seed, else a constant) */
  seed?: number;
  /** timer hooks for the latency (default the globals; tests and rooms pass a manual clock's) */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  model?: string;
  /** try the purpose prefix before ":" (default true) */
  matchPrefix?: boolean;
  /** serve the last recording of a key again once the key is exhausted (default true) */
  repeatLast?: boolean;
  /**
   * how many recent requests to keep in `calls` (oldest dropped first). Default: unlimited, which is
   * what tests want; long-lived instances (the server's "mock" preset) must pass 0 or a small number,
   * otherwise every request body stays in memory for the life of the process.
   */
  maxCalls?: number;
}

/** small deterministic PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toValue(r: Recording | MockResponseValue): Omit<Recording, 'purpose' | 'hash'> {
  return typeof r === 'string' ? { text: r } : r;
}

function purposeMatches(purpose: string, list: string[]): boolean {
  return list.some((p) => p === purpose || purpose.split(':')[0] === p);
}

export class MockProvider implements LLMProvider {
  readonly id = 'mock';
  readonly model: string;
  /** requests seen, in order (tests inspect this); only the latest `maxCalls` are kept */
  readonly calls: CompletionRequest[] = [];
  /** total requests seen, including ones no longer kept in `calls` */
  callCount = 0;
  private readonly maxCalls: number;
  private readonly table = new Map<string, Omit<Recording, 'purpose' | 'hash'>[]>();
  private readonly served = new Map<string, number>();
  private readonly opts: MockProviderOptions;
  private readonly rand: () => number;
  private failuresInjected = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.opts = opts;
    this.model = opts.model ?? 'mock';
    const mc = opts.maxCalls;
    this.maxCalls = mc === undefined || !Number.isFinite(mc) ? Infinity : Math.max(0, Math.floor(mc));
    this.rand = mulberry32(opts.seed ?? opts.failure?.seed ?? 1234567);
    for (const r of opts.recordings ?? []) this.add(r);
    for (const [key, v] of Object.entries(opts.responses ?? {})) {
      for (const one of Array.isArray(v) ? v : [v]) this.addKey(key, toValue(one));
    }
  }

  private record(req: CompletionRequest): void {
    this.callCount++;
    if (this.maxCalls === 0) return;
    this.calls.push(req);
    if (this.calls.length > this.maxCalls) this.calls.splice(0, this.calls.length - this.maxCalls);
  }

  static key(purpose: string, hash?: string): string {
    return hash ? `${purpose}#${hash}` : purpose;
  }

  /** the keys tried for a request, most specific first (see the lookup order above) */
  static lookupKeys(purpose: string, hash: string, matchPrefix = true): string[] {
    const keys = [MockProvider.key(purpose, hash), purpose];
    const segs = purpose.split('/');
    for (let n = segs.length - 1; n >= 1; n--) keys.push(segs.slice(0, n).join('/'));
    const bare = segs[0]!;
    if (matchPrefix && bare.includes(':')) keys.push(bare.split(':')[0]!);
    return [...new Set(keys)];
  }

  /** add a recording at runtime */
  add(r: Recording): void {
    this.addKey(MockProvider.key(r.purpose, r.hash), toValue(r));
  }

  private addKey(key: string, value: Omit<Recording, 'purpose' | 'hash'>): void {
    const list = this.table.get(key) ?? [];
    list.push(value);
    this.table.set(key, list);
  }

  /** number of recordings stored under a key */
  count(key: string): number {
    return this.table.get(key)?.length ?? 0;
  }

  private take(key: string): Omit<Recording, 'purpose' | 'hash'> | undefined {
    const list = this.table.get(key);
    if (!list || !list.length) return undefined;
    const i = this.served.get(key) ?? 0;
    if (i >= list.length && this.opts.repeatLast === false) return undefined;
    this.served.set(key, i + 1);
    return list[Math.min(i, list.length - 1)];
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    const l = this.opts.latencyMs;
    if (l === undefined) return;
    const ms = Array.isArray(l) ? l[0] + (l[1] - l[0]) * this.rand() : l;
    if (ms <= 0) return;
    const setTimer = this.opts.setTimer ?? ((fn: () => void, n: number) => setTimeout(fn, n));
    const clearTimer = this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new LLMAbortedError(undefined, { provider: this.id }));
      const t = setTimer(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimer(t);
        reject(new LLMAbortedError(undefined, { provider: this.id }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private injectedFailure(req: CompletionRequest): MockFailureMode | null {
    const f = this.opts.failure;
    if (!f) return null;
    if (f.purposes && !purposeMatches(req.purpose, f.purposes)) return null;
    if (f.failFirst !== undefined) {
      if (this.failuresInjected < f.failFirst) {
        this.failuresInjected++;
        return f.mode;
      }
      return null;
    }
    if (f.probability !== undefined && this.rand() < f.probability) {
      this.failuresInjected++;
      return f.mode;
    }
    return null;
  }

  private throwFor(mode: MockFailureMode): CompletionResponse {
    const init = { provider: this.id };
    let err: LLMError;
    switch (mode) {
      case 'rate_limit':
        err = new LLMRateLimitError('mock: injected rate limit', { ...init, status: 429, retryAfterMs: this.opts.failure?.retryAfterMs ?? 1000 });
        break;
      case 'server':
        err = new LLMServerError('mock: injected server error', { ...init, status: 503 });
        break;
      case 'network':
        err = new LLMNetworkError('mock: injected network error', init);
        break;
      case 'timeout':
        err = new LLMTimeoutError('mock: injected timeout', init);
        break;
      case 'refusal':
        err = new LLMRefusalError('mock: injected refusal', init);
        break;
      case 'invalid_json':
        return { text: '{"this is": not valid json', model: this.model, stopReason: 'end_turn' };
      case 'empty':
        return { text: '', model: this.model, stopReason: 'end_turn' };
    }
    throw err;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.record(req);
    await this.delay(req.signal);
    if (req.signal?.aborted) throw new LLMAbortedError(undefined, { provider: this.id });
    const failure = this.injectedFailure(req);
    if (failure) return this.throwFor(failure);

    const hash = requestHash(req);
    const keys = MockProvider.lookupKeys(req.purpose, hash, this.opts.matchPrefix !== false);
    for (const k of keys) {
      const v = this.take(k);
      if (v) return this.respond(v);
    }
    if (this.opts.fallback) {
      const out = await this.opts.fallback(req);
      if (typeof out === 'string') return { text: out, model: this.model, stopReason: 'end_turn' };
      if (out) return out;
    }
    throw new LLMInvalidResponseError(`mock: no recording for purpose "${req.purpose}" (hash ${hash})`, { provider: this.id });
  }

  private respond(v: Omit<Recording, 'purpose' | 'hash'>): CompletionResponse {
    const text = v.text ?? (v.json !== undefined ? JSON.stringify(v.json) : '');
    return {
      text,
      model: v.model ?? this.model,
      stopReason: v.stopReason ?? 'end_turn',
      usage: v.usage ?? { inputTokens: 0, outputTokens: Math.ceil(text.length / 4) },
    };
  }
}

/** Normalise the JSON shapes a recordings file may have: one recording, an array, or {recordings:[…]}. */
export function parseRecordingsFile(json: unknown): Recording[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { recordings?: unknown }).recordings)
      ? (json as { recordings: unknown[] }).recordings
      : [json];
  const out: Recording[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Recording;
    if (typeof rec.purpose !== 'string') continue;
    if (rec.text === undefined && rec.json === undefined) continue;
    out.push(rec);
  }
  return out;
}
