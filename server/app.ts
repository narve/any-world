/**
 * AnyWorld backend: plain node:http, no framework.
 *   POST /api/llm      {preset, model?, request} -> {response}  (keys come from the server env)
 *   GET  /api/presets  which presets this server can serve (never keys)
 *   GET  /api/health  {ok, uptimeS, configured, engine} (engine: the engine version rooms check, MP2)
 *   everything else    dist/client static files with SPA fallback (when staticDir is set)
 * Optional (MP0, home hosting): ANYWORLD_HOST_CODE makes POST /api/llm (real providers, not the
 * recorded "mock") require the header X-AnyWorld-Code, so strangers cannot spend the server's keys;
 * ALLOWED_ORIGINS (comma-separated) lets pages hosted elsewhere (e.g. GitHub Pages) call /api (CORS).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { PRESETS, getPreset } from '../src/llm/presets';
import { createDirectProvider } from '../src/llm/transport';
import { MockProvider, type Recording } from '../src/llm/mock';
import { loadRecordingsFromDir } from '../src/llm/recordings-node';
import { LLMError } from '../src/llm/errors';
import { DEFAULT_TIMEOUT_MS, redact, type FetchLike, type HttpOptions } from '../src/llm/http';
import type { CompletionResponse, LLMProvider, ProviderPreset } from '../src/llm/types';
import { RateLimiter, type RateLimitOptions } from './rate-limit';
import { serveStatic } from './static';
import { engineVersionFor } from './engine-version';

export interface AppOptions {
  /** environment to read keys/config from; default process.env */
  env?: Record<string, string | undefined>;
  /** fetch used for upstream LLM calls (tests inject a mock upstream) */
  fetch?: FetchLike;
  /** upstream HTTP behaviour */
  upstream?: Pick<HttpOptions, 'timeoutMs' | 'totalTimeoutMs' | 'maxRetries' | 'retryBaseMs' | 'maxRetryDelayMs' | 'retryOnTimeout'>;
  /** serve static files from here (production); undefined = API only */
  staticDir?: string;
  /** per-IP limit for POST /api/llm */
  rateLimit?: RateLimitOptions;
  /** max request body; default 4 MB */
  maxBodyBytes?: number;
  /** clamp for request.maxTokens; default 32000 */
  maxOutputTokens?: number;
  /** recordings for the "mock" preset; default: loaded lazily from content/recordings */
  recordings?: Recording[];
  recordingsDir?: string;
  /**
   * Honour X-Forwarded-For for the rate-limit key (behind a reverse proxy). A number is the count of
   * trusted proxy hops in front of this server (true = 1); see parseTrustProxy / clientIpFrom.
   * Env TRUST_PROXY: "1"/"true" = one hop, an integer N = N hops, unset/"0"/"false" = ignore the header.
   */
  trustProxy?: boolean | number;
  /** request log sink; default console.log; pass () => {} to silence */
  log?: (line: string) => void;
  /** max cached upstream providers (one per preset+model, LRU-evicted); default LLM_MAX_CACHED_PROVIDERS or 64 */
  maxCachedProviders?: number;
  /** access code for AI calls (header X-AnyWorld-Code); default env ANYWORLD_HOST_CODE; empty = no code */
  hostCode?: string;
  /** origins allowed to call /api from another site (CORS); default env ALLOWED_ORIGINS, comma-separated */
  allowedOrigins?: string[];
  /**
   * The engine version this server plays (MP2 design §8), reported by /api/health; default
   * engineVersionFor(env): the hash of the checkout, or ANYWORLD_ENGINE_VERSION outside production.
   */
  engineVersion?: string;
}

/** the header that carries the host access code */
export const HOST_CODE_HEADER = 'x-anyworld-code';

/** constant-time comparison of two codes (hashed first, so lengths do not leak either) */
export function codeMatches(given: string | undefined, expected: string): boolean {
  const a = createHash('sha256').update(given ?? '').digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** ALLOWED_ORIGINS → normalized origins ("https://x.github.io"); entries that are not origins are dropped */
export function parseAllowedOrigins(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .flatMap((o) => {
      try {
        const u = new URL(o);
        return u.protocol === 'https:' || u.protocol === 'http:' ? [u.origin] : [];
      } catch {
        return [];
      }
    });
}

/** positive integer from an env var, or undefined (unset / invalid) */
function envInt(v: string | undefined, min = 0): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : undefined;
}

/**
 * Upstream HTTP settings: env LLM_TIMEOUT_MS (per attempt, default 600 s), LLM_TOTAL_TIMEOUT_MS
 * (attempts + backoff, default = per-attempt timeout), LLM_MAX_RETRIES (default 2; 429/5xx/network
 * only: a call our own timer gave up on is never re-sent). Explicit `opts.upstream` wins.
 * In Node, postJson lifts undici's built-in 300 s headers/body timeouts for these calls, so
 * LLM_TIMEOUT_MS really is the limit (and an undici timeout is a non-resent timeout, not a network error).
 */
export function upstreamOptions(env: Record<string, string | undefined>, explicit: AppOptions['upstream'] = {}): NonNullable<AppOptions['upstream']> {
  const timeoutMs = explicit.timeoutMs ?? envInt(env.LLM_TIMEOUT_MS, 1) ?? DEFAULT_TIMEOUT_MS;
  return {
    ...explicit,
    timeoutMs,
    totalTimeoutMs: explicit.totalTimeoutMs ?? envInt(env.LLM_TOTAL_TIMEOUT_MS, 1) ?? timeoutMs,
    maxRetries: explicit.maxRetries ?? envInt(env.LLM_MAX_RETRIES) ?? 2,
    retryOnTimeout: explicit.retryOnTimeout ?? false,
  };
}

/** TRUST_PROXY env value -> number of trusted proxy hops (0 = do not trust X-Forwarded-For) */
export function parseTrustProxy(v: string | undefined): number {
  const t = (v ?? '').trim().toLowerCase();
  if (t === 'true' || t === 'yes') return 1;
  const n = Number(t);
  return t !== '' && Number.isInteger(n) && n > 0 ? Math.min(n, 32) : 0;
}

/**
 * Rate-limit key for a request. Without trusted hops it is the socket peer. With `hops` trusted
 * reverse proxies, each of which APPENDS the address it received the connection from to
 * X-Forwarded-For, the real client is the hops-th entry from the RIGHT. Everything to the left of it
 * was sent by the client and can be spoofed, so the left-most entry must never be used. If the
 * header has fewer entries than hops (the request skipped an outer proxy) the left-most available
 * entry is used; a malformed entry falls back to the socket peer.
 */
export function clientIpFrom(xff: string | string[] | undefined, remoteAddress: string | undefined, hops: number): string {
  const peer = remoteAddress ?? 'unknown';
  if (hops <= 0 || xff === undefined) return peer;
  const entries = (Array.isArray(xff) ? xff.join(',') : xff)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return peer;
  const pick = entries[Math.max(0, entries.length - hops)]!;
  return isIP(pick) ? pick : peer;
}

const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,128}$/;

export const LlmRequestBody = z.object({
  preset: z.string().min(1).max(64),
  model: z.string().regex(MODEL_RE, 'invalid model id').optional(),
  request: z.object({
    system: z.string().max(1_000_000),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(1_000_000) }))
      .min(1)
      .max(200),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
    schemaName: z.string().max(64).optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    purpose: z.string().min(1).max(100),
    schemaInPrompt: z.boolean().optional(),
  }),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, kind: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): void {
  // `type` mirrors `kind` so generic clients (extractErrorMessage) pick it up as the error code
  sendJson(res, status, { error: { kind, type: kind, message, ...extra } }, headers);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'bad_request', `Request body larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new HttpError(413, 'bad_request', `Request body larger than ${limit} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function envName(presetId: string, suffix: string): string {
  return `${presetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

export interface App {
  server: Server;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** presets usable server-side */
  configuredPresets(): string[];
  /** number of cached upstream providers (bounded by maxCachedProviders) */
  cachedProviderCount(): number;
}

export function createApp(opts: AppOptions = {}): App {
  const env = opts.env ?? process.env;
  const engineVersion = opts.engineVersion ?? engineVersionFor(env);
  const log = opts.log ?? ((l: string) => console.log(l));
  const limiter = new RateLimiter({
    perMinute: opts.rateLimit?.perMinute ?? (Number(env.LLM_RATE_PER_MIN) || 30),
    burst: opts.rateLimit?.burst ?? (Number(env.LLM_RATE_BURST) || 10),
    now: opts.rateLimit?.now,
  });
  const maxBody = opts.maxBodyBytes ?? (Number(env.LLM_MAX_BODY_BYTES) || 4 * 1024 * 1024);
  const maxOut = opts.maxOutputTokens ?? (Number(env.LLM_MAX_OUTPUT_TOKENS) || 32_000);
  const allowAnyModel = env.LLM_ALLOW_ANY_MODEL === '1' || env.LLM_ALLOW_ANY_MODEL === 'true';
  const trustHops =
    opts.trustProxy === undefined ? parseTrustProxy(env.TRUST_PROXY) : opts.trustProxy === true ? 1 : opts.trustProxy === false ? 0 : Math.max(0, Math.floor(opts.trustProxy));
  const upstream = upstreamOptions(env, opts.upstream);
  const hostCode = (opts.hostCode ?? env.ANYWORLD_HOST_CODE ?? '').trim();
  const allowedOrigins = new Set(opts.allowedOrigins ?? parseAllowedOrigins(env.ALLOWED_ORIGINS));
  const secrets = (): string[] => PRESETS.map((p) => (p.envKey ? env[p.envKey] ?? '' : '')).filter(Boolean);
  /** cached per preset+model; LRU-capped so open presets cannot grow server memory without bound */
  const providers = new Map<string, LLMProvider>();
  const maxProviders = Math.max(1, opts.maxCachedProviders ?? (Number(env.LLM_MAX_CACHED_PROVIDERS) || 64));
  let mock: MockProvider | null = null;

  const keyFor = (p: ProviderPreset): string | undefined => (p.envKey ? env[p.envKey]?.trim() || undefined : undefined);
  const baseUrlFor = (p: ProviderPreset): string | undefined => (p.baseUrlEnv ? env[p.baseUrlEnv]?.trim() || undefined : undefined);
  const defaultModelFor = (p: ProviderPreset): string => env[envName(p.id, 'MODEL')]?.trim() || (p.id === 'custom' ? env.CUSTOM_LLM_MODEL?.trim() || '' : '') || p.defaultModel;

  /**
   * Models a client may pick for a preset, or null when any model is allowed. Keyed (paid) presets
   * are always closed: the default model, preset.models and an operator list in <ID>_MODELS
   * (comma-separated, e.g. OPENROUTER_MODELS=a,b; CUSTOM_MODELS for the custom preset). A preset is
   * "keyed" when it needs a key OR the operator configured one (e.g. CUSTOM_LLM_API_KEY pointing the
   * custom preset at a paid host). Only presets with no key at all (local servers) and no model list
   * stay open; LLM_ALLOW_ANY_MODEL=1 opens all.
   */
  const allowedModelsFor = (p: ProviderPreset): Set<string> | null => {
    if (allowAnyModel) return null;
    const extra = (env[envName(p.id, 'MODELS')] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    const listed = [...(p.models ?? []), ...extra];
    if (!p.needsKey && !keyFor(p) && listed.length === 0) return null;
    return new Set([defaultModelFor(p), ...listed].filter(Boolean));
  };

  const isConfigured = (p: ProviderPreset): boolean => {
    if (p.needsKey) return !!keyFor(p);
    // keyless presets (local servers, custom) must be pointed at explicitly on a server
    return !!baseUrlFor(p) && !!defaultModelFor(p);
  };

  const configuredPresets = (): string[] => [...PRESETS.filter(isConfigured).map((p) => p.id), 'mock'];

  const getMock = async (): Promise<MockProvider> => {
    if (!mock) {
      const recs = opts.recordings ?? (await loadRecordingsFromDir(opts.recordingsDir ?? 'content/recordings'));
      // maxCalls 0: a long-lived provider must not keep request bodies (unbounded memory otherwise)
      mock = new MockProvider({ recordings: recs, maxCalls: 0 });
    }
    return mock;
  };

  const providerFor = (p: ProviderPreset, model: string): LLMProvider => {
    const k = `${p.id}|${model}`;
    let prov = providers.get(k);
    if (prov) {
      // refresh recency (Map iteration order is insertion order)
      providers.delete(k);
      providers.set(k, prov);
    } else {
      prov = createDirectProvider(
        p,
        { apiKey: keyFor(p), baseUrl: baseUrlFor(p), model },
        { fetch: opts.fetch, browser: false, ...upstream },
      );
      providers.set(k, prov);
      while (providers.size > maxProviders) providers.delete(providers.keys().next().value!);
    }
    return prov;
  };

  const clientIp = (req: IncomingMessage): string => clientIpFrom(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustHops);

  async function handleLlm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const rl = limiter.take(ip);
    if (!rl.allowed) {
      const s = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      throw new HttpError(429, 'rate_limit', 'Too many requests; slow down', { 'retry-after': String(s) });
    }
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'bad_request', 'Content-Type must be application/json');
    const raw = await readBody(req, maxBody);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'bad_request', 'Body is not valid JSON');
    }
    const parsed = LlmRequestBody.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
      throw new HttpError(400, 'bad_request', `Invalid request: ${msg}`);
    }
    const body = parsed.data;
    // the recorded "mock" preset costs nothing and stays open; real providers need the code when one is set
    if (hostCode && body.preset !== 'mock') {
      const given = req.headers[HOST_CODE_HEADER];
      if (!codeMatches(typeof given === 'string' ? given.trim() : undefined, hostCode)) {
        log(`[llm] ${body.preset} refused: ${given ? 'wrong' : 'missing'} access code (${ip})`);
        throw new HttpError(401, 'auth', given ? 'Wrong server access code' : 'This server needs an access code (Settings → Server access code)');
      }
    }
    const request = { ...body.request, maxTokens: Math.min(body.request.maxTokens ?? maxOut, maxOut) };

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const started = Date.now();
    let provider: LLMProvider;
    let model: string;
    if (body.preset === 'mock') {
      provider = await getMock();
      model = provider.model;
    } else {
      const preset = getPreset(body.preset);
      if (!preset) throw new HttpError(404, 'config', `Unknown preset "${body.preset}"`);
      if (!isConfigured(preset)) throw new HttpError(503, 'config', `Preset "${preset.id}" is not configured on this server`);
      model = body.model ?? defaultModelFor(preset);
      const allowed = allowedModelsFor(preset);
      if (allowed && !allowed.has(model)) {
        throw new HttpError(400, 'bad_request', `Model "${model}" is not allowed for preset "${preset.id}" on this server`);
      }
      provider = providerFor(preset, model);
    }
    try {
      const out: CompletionResponse = await provider.complete({ ...request, signal: ac.signal });
      log(`[llm] ${body.preset} ${model} ${request.purpose} ok ${Date.now() - started}ms in=${out.usage?.inputTokens ?? '?'} out=${out.usage?.outputTokens ?? '?'}`);
      sendJson(res, 200, { response: out });
    } catch (e) {
      log(`[llm] ${body.preset} ${model} ${request.purpose} fail ${Date.now() - started}ms ${e instanceof LLMError ? e.kind : 'error'}`);
      throw e;
    }
  }

  function presetsInfo() {
    return {
      /** true: POST /api/llm with a real provider needs the X-AnyWorld-Code header */
      codeRequired: !!hostCode,
      /** clients waiting on /api/llm should allow at least this long (the server answers 504 after it) */
      upstreamTimeoutMs: upstream.totalTimeoutMs,
      presets: [
        ...PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          region: p.region,
          kind: p.kind,
          defaultModel: defaultModelFor(p),
          models: (() => {
            const a = allowedModelsFor(p);
            return a ? [...a] : p.models;
          })(),
          /** false: the server accepts any model id for this preset */
          modelsRestricted: allowedModelsFor(p) !== null,
          structuredOutput: p.structuredOutput,
          configured: isConfigured(p),
        })),
        { id: 'mock', label: 'Recorded responses', region: 'Local', kind: 'openai-compatible', defaultModel: 'mock', structuredOutput: 'none', configured: true },
      ],
    };
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Node accepts absolute-form targets (`GET http://[ HTTP/1.1`), so parsing can throw: keep it
    // inside the try so a bad target is a 400, never an unhandled rejection.
    let path = '?';
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://local');
      } catch {
        throw new HttpError(400, 'bad_request', 'Invalid request target');
      }
      path = url.pathname;
      if (path.startsWith('/api/')) {
        // CORS for pages hosted elsewhere: only listed origins get the allow headers
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
        if (origin && allowedOrigins.has(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'origin');
        }
        if (req.method === 'OPTIONS') {
          if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, 'bad_request', 'Origin not allowed');
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': `content-type, ${HOST_CODE_HEADER}`,
            'access-control-max-age': '600',
          });
          res.end();
          return;
        }
        if (path === '/api/health') {
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'bad_request', 'Method not allowed', { allow: 'GET' });
          return sendJson(res, 200, { ok: true, uptimeS: Math.round(process.uptime()), configured: configuredPresets(), engine: engineVersion });
        }
        if (path === '/api/presets') {
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'bad_request', 'Method not allowed', { allow: 'GET' });
          return sendJson(res, 200, presetsInfo());
        }
        if (path === '/api/llm') {
          if (req.method !== 'POST') throw new HttpError(405, 'bad_request', 'Method not allowed', { allow: 'POST' });
          return await handleLlm(req, res);
        }
        throw new HttpError(404, 'bad_request', 'Unknown API route');
      }
      if (opts.staticDir && (await serveStatic(req, res, opts.staticDir))) return;
      sendError(res, 404, 'bad_request', 'Not found');
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return sendError(res, e.status, e.kind, e.message, {}, e.headers);
      if (e instanceof LLMError) {
        const message = redact(e.message, secrets());
        const extra: Record<string, unknown> = e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {};
        switch (e.kind) {
          case 'rate_limit': {
            const h: Record<string, string> = e.retryAfterMs !== undefined ? { 'retry-after': String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) } : {};
            return sendError(res, 429, e.kind, message, extra, h);
          }
          case 'timeout': return sendError(res, 504, e.kind, message, extra);
          case 'bad_request': return sendError(res, 400, e.kind, message, extra);
          case 'refusal': return sendError(res, 422, e.kind, message, extra);
          case 'config': return sendError(res, 503, e.kind, message, extra);
          case 'aborted': return sendError(res, 499, e.kind, message, extra);
          case 'auth': return sendError(res, 502, e.kind, `Upstream rejected the server's credentials: ${message}`, extra);
          default: return sendError(res, 502, e.kind, message, extra);
        }
      }
      log(`[server] unexpected error on ${req.method} ${path}: ${redact(String((e as Error)?.stack ?? e), secrets())}`);
      sendError(res, 500, 'server', 'Internal server error');
    }
  };

  const server = createServer((req, res) => {
    // last line of defence: nothing thrown by a request may take the process down
    handler(req, res).catch((e: unknown) => {
      try {
        log(`[server] unhandled error on ${req.method} ${req.url}: ${redact(String((e as Error)?.stack ?? e), secrets())}`);
      } catch {
        /* logging must not throw either */
      }
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal server error');
      else res.destroy();
    });
  });
  return { server, handler, configuredPresets, cachedProviderCount: () => providers.size };
}
