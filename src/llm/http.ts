/**
 * Minimal JSON-over-HTTP helper used by every provider: global fetch, per-attempt timeout via
 * AbortController, caller AbortSignal support, status -> typed error mapping, retry-after aware
 * retries for transient failures. Works in browsers and Node 18+.
 */
import {
  LLMAbortedError,
  LLMAuthError,
  LLMBadRequestError,
  LLMError,
  LLMInvalidResponseError,
  LLMNetworkError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
  type LLMErrorInit,
} from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** fetch implementation (tests inject a mock); defaults to globalThis.fetch */
  fetch?: FetchLike;
  /** per-attempt timeout; default 600 s (world generation is a long non-streaming call) */
  timeoutMs?: number;
  /**
   * overall deadline across all attempts and backoff pauses; default none (each attempt gets the full
   * `timeoutMs`). Attempts are cut short to fit, and no retry starts that could not finish in time.
   */
  totalTimeoutMs?: number;
  /** extra attempts for transient failures (429, 5xx, network, upstream 408); default 2 */
  maxRetries?: number;
  /**
   * also retry when our own per-attempt timer expires; default false. The upstream usually keeps
   * generating (and billing) a request we gave up on, so re-sending a long call that timed out
   * multiplies the cost without making it any faster. An upstream HTTP 408 is always retryable.
   */
  retryOnTimeout?: boolean;
  /** base for exponential backoff; default 1000 ms */
  retryBaseMs?: number;
  /** never wait longer than this between attempts; a longer retry-after is surfaced instead. default 30 s */
  maxRetryDelayMs?: number;
  /**
   * undici dispatcher handed to fetch as `init.dispatcher` (Node only). Default: when the built-in
   * global fetch is used in Node, the global dispatcher with undici's 300 s headers/body timeouts
   * turned off for our requests, so `timeoutMs` (our own timer) is what bounds a long call. Pass
   * `false` to send no dispatcher. Ignored by browsers.
   */
  dispatcher?: unknown | false;
}

export interface PostJsonArgs {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
  signal?: AbortSignal;
  /** strings that must never appear in error messages (API keys) */
  secrets?: string[];
}

export interface JsonResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

/** per-attempt upstream timeout (same order as the official SDKs' 10 min default) */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** default overall budget the server gives one /api/llm request (attempts + backoff) */
export const DEFAULT_SERVER_TOTAL_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
/** default client-side wait for /api/llm: longer than the server's budget so the server's 504 arrives first */
export const DEFAULT_BACKEND_TIMEOUT_MS = DEFAULT_SERVER_TOTAL_TIMEOUT_MS + 60_000;
/** LLMError.code set when a client-side timer (ours or undici's), not the upstream, ended the call */
export const LOCAL_TIMEOUT_CODE = 'local_timeout';

export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out;
}

/** retry-after-ms / retry-after (seconds or HTTP date) -> milliseconds */
export function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const t = ra.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const when = Date.parse(t);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Pull a readable message out of an Anthropic / OpenAI / generic error body. */
export function extractErrorMessage(json: unknown, rawText: string): { message: string; code?: string } {
  if (json && typeof json === 'object') {
    const j = json as Record<string, unknown>;
    const err = j.error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const message = typeof e.message === 'string' ? e.message : JSON.stringify(e).slice(0, 300);
      const code = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : undefined;
      return { message, code };
    }
    if (typeof err === 'string') return { message: err };
    if (typeof j.message === 'string') return { message: j.message };
    if (typeof j.detail === 'string') return { message: j.detail };
  }
  return { message: rawText.slice(0, 300) || 'no response body' };
}

export function errorForStatus(status: number, message: string, init: LLMErrorInit): LLMError {
  const msg = `${init.provider ?? 'LLM'} HTTP ${status}: ${message}`;
  if (status === 401 || status === 403) return new LLMAuthError(msg, init);
  if (status === 429) return new LLMRateLimitError(msg, init);
  if (status === 408) return new LLMTimeoutError(msg, init);
  if (status >= 500) return new LLMServerError(msg, init);
  return new LLMBadRequestError(msg, init);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LLMAbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LLMAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** undici error codes for its own built-in headers/body timers (300 s by default in Node's fetch) */
const UNDICI_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** the undici timeout code anywhere in `e`'s cause chain (fetch wraps it: TypeError -> cause), or undefined */
export function undiciTimeoutCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && UNDICI_TIMEOUT_CODES.has(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** where Node's bundled undici keeps the global dispatcher (stable across Node 18-24) */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

interface ComposableDispatcher {
  compose(interceptor: (dispatch: (opts: Record<string, unknown>, handler: unknown) => unknown) => (opts: Record<string, unknown>, handler: unknown) => unknown): unknown;
}

const longCallDispatchers = new WeakMap<object, unknown>();

/**
 * Node's global undici dispatcher (keeping its proxy / connection pool setup) with the per-request
 * headersTimeout and bodyTimeout set to 0 (off): our AbortController timer bounds every attempt, and
 * undici's 300 s defaults would otherwise cut a long non-streaming generation short. Recomputed when
 * the global dispatcher is replaced. undefined outside Node or when the dispatcher cannot compose.
 */
export function longCallDispatcher(): unknown {
  const g = (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER];
  if (!g || typeof g !== 'object' || typeof (g as Partial<ComposableDispatcher>).compose !== 'function') return undefined;
  let d = longCallDispatchers.get(g);
  if (!d) {
    try {
      d = (g as ComposableDispatcher).compose(
        (dispatch) => (opts, handler) => dispatch({ ...opts, headersTimeout: 0, bodyTimeout: 0 }, handler),
      );
    } catch {
      return undefined;
    }
    longCallDispatchers.set(g, d);
  }
  return d;
}

/** One attempt: POST JSON, read JSON, map failures. */
async function attempt(args: PostJsonArgs, opts: HttpOptions, timeoutMs: number): Promise<JsonResponse> {
  const fetchImpl: FetchLike | undefined = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  if (!fetchImpl) throw new LLMNetworkError('No fetch implementation available', { provider: args.provider });
  // an injected fetch may not be undici's (or a different undici version): only an explicit dispatcher goes to it
  const dispatcher = opts.dispatcher === false ? undefined : (opts.dispatcher ?? (opts.fetch ? undefined : longCallDispatcher()));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (args.signal) {
    if (args.signal.aborted) {
      clearTimeout(timer);
      throw new LLMAbortedError(undefined, { provider: args.provider });
    }
    args.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const base: LLMErrorInit = { provider: args.provider };
  const fail = (e: unknown): never => {
    if (e instanceof LLMError) throw e;
    if (args.signal?.aborted) throw new LLMAbortedError(undefined, { ...base, cause: e });
    if (timedOut) throw new LLMTimeoutError(`${args.provider}: no response within ${timeoutMs} ms`, { ...base, code: LOCAL_TIMEOUT_CODE, cause: e });
    // undici's own headers/body timer: the upstream got the request and is (probably) still generating
    // and billing it, exactly like our own timer expiring, so it gets the same no-resend policy
    const undiciCode = undiciTimeoutCode(e);
    if (undiciCode) {
      throw new LLMTimeoutError(`${args.provider}: no response before the HTTP client gave up (${undiciCode})`, {
        ...base,
        code: LOCAL_TIMEOUT_CODE,
        cause: e,
      });
    }
    const m = e instanceof Error ? e.message : String(e);
    throw new LLMNetworkError(`${args.provider}: network error: ${redact(m, args.secrets)}`, { ...base, cause: e });
  };
  try {
    let res: Response;
    try {
      const init: RequestInit & { dispatcher?: unknown } = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...args.headers },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      };
      if (dispatcher !== undefined) init.dispatcher = dispatcher;
      res = await fetchImpl(args.url, init);
    } catch (e) {
      return fail(e);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      return fail(e);
    }
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const { message, code } = extractErrorMessage(json, text);
      throw errorForStatus(res.status, redact(message, args.secrets), {
        ...base,
        status: res.status,
        code,
        retryAfterMs: parseRetryAfter(res.headers),
      });
    }
    if (json === undefined) {
      throw new LLMInvalidResponseError(
        `${args.provider}: response is not JSON: ${redact(text.slice(0, 200), args.secrets)}`,
        { ...base, status: res.status },
      );
    }
    return { status: res.status, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** true when a client-side timer (ours, or undici's built-in one) ended the call, as opposed to an upstream 408 */
export function isLocalTimeout(e: unknown): boolean {
  return e instanceof LLMTimeoutError && e.code === LOCAL_TIMEOUT_CODE;
}

/** POST JSON with retries for transient failures. */
export async function postJson(args: PostJsonArgs, opts: HttpOptions = {}): Promise<JsonResponse> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const base = opts.retryBaseMs ?? 1000;
  const cap = opts.maxRetryDelayMs ?? 30_000;
  const perAttempt = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const total = opts.totalTimeoutMs;
  const started = Date.now();
  const remaining = (): number => (total === undefined ? Infinity : total - (Date.now() - started));
  for (let i = 0; ; i++) {
    const left = remaining();
    try {
      return await attempt(args, opts, Math.max(1, Math.min(perAttempt, left)));
    } catch (e) {
      if (!(e instanceof LLMError) || !e.retryable || i >= maxRetries) throw e;
      if (isLocalTimeout(e) && !opts.retryOnTimeout) throw e;
      let delay = e.retryAfterMs ?? Math.round(base * 2 ** i * (0.75 + Math.random() * 0.5));
      if (delay > cap) {
        if (e.retryAfterMs !== undefined) throw e; // server asked for a longer pause than we accept
        delay = cap;
      }
      // a retry that cannot even start before the overall deadline only burns quota
      if (delay >= remaining()) throw e;
      await sleep(delay, args.signal);
    }
  }
}
