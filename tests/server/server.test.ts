import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../../server/index';
import { RateLimiter } from '../../server/rate-limit';
import { createProvider } from '../../src/llm/transport';
import { LLMRateLimitError, LLMAuthError } from '../../src/llm/errors';
import { anthropicMessage, chatCompletion, json, mockFetch, type FetchCall } from '../llm/helpers';

const KEY = 'sk-ant-server-secret-0042';
const DS_KEY = 'sk-ds-server-secret-77';

let upstreamMode: 'ok' | 'auth' | 'rate' | 'hang' = 'ok';
const upstream = mockFetch((call: FetchCall) => {
  if (upstreamMode === 'auth') return json({ type: 'error', error: { type: 'authentication_error', message: `bad key ${KEY}` } }, 401);
  if (upstreamMode === 'rate') return json({ error: { type: 'rate_limit_error', message: 'busy' } }, 429, { 'retry-after': '600' });
  if (upstreamMode === 'hang') {
    return new Promise<Response>((_r, rej) => call.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  }
  if (call.url.includes('anthropic')) return json(anthropicMessage(`echo:${call.body.messages[0].content}`));
  return json(chatCompletion(`ds:${call.body.model}`));
});

let base = '';
let close: () => Promise<void>;
let staticDir = '';
const logs: string[] = [];

const body = (extra: Record<string, unknown> = {}) => ({
  preset: 'anthropic',
  request: { system: 'sys', messages: [{ role: 'user', content: 'hello' }], purpose: 'dialogue' },
  ...extra,
});

async function post(b: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}/api/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof b === 'string' ? b : JSON.stringify(b),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'client-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>AnyWorld</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(staticDir, 'style.css'), 'body{}');
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    env: { ANTHROPIC_API_KEY: KEY, DEEPSEEK_API_KEY: DS_KEY },
    fetch: upstream,
    upstream: { maxRetries: 0, timeoutMs: 300 },
    staticDir,
    rateLimit: { perMinute: 600, burst: 30 },
    recordings: [{ purpose: 'dialogue', text: 'recorded line' }],
    log: (l) => logs.push(l),
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});

afterAll(async () => {
  await close?.();
});

describe('server API', () => {
  it('GET /api/health', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.configured).toEqual(['anthropic', 'deepseek', 'mock']);
  });

  it('GET /api/presets lists presets with configured flags and no keys', async () => {
    const res = await fetch(`${base}/api/presets`);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(DS_KEY);
    const { presets } = JSON.parse(text);
    const byId = Object.fromEntries(presets.map((p: any) => [p.id, p]));
    expect(byId.anthropic.configured).toBe(true);
    expect(byId.deepseek.configured).toBe(true);
    expect(byId.mistral.configured).toBe(false);
    expect(byId.ollama.configured).toBe(false);
    expect(byId.mock.configured).toBe(true);
    expect(Object.keys(byId.anthropic)).not.toContain('envKey');
  });

  it('POST /api/llm proxies to the upstream with the server key', async () => {
    upstreamMode = 'ok';
    const before = upstream.calls.length;
    const r = await post(body());
    expect(r.status).toBe(200);
    expect(r.json.response.text).toBe('echo:hello');
    expect(r.json.response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    const call = upstream.calls[before]!;
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(call.body.max_tokens).toBe(32_000); // clamped default
    expect(JSON.stringify(r.json)).not.toContain(KEY);
    expect(logs.some((l) => l.includes('[llm] anthropic') && !l.includes(KEY))).toBe(true);
  });

  it('works end-to-end through BackendProvider, incl. OpenAI-compatible presets and model allow-list', async () => {
    upstreamMode = 'ok';
    const p = createProvider({ preset: 'deepseek', model: 'deepseek-reasoner', transport: 'backend' }, { backendUrl: base });
    const r = await p.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], purpose: 'gm:test' });
    expect(r.text).toBe('ds:deepseek-reasoner');
    const last = upstream.calls.at(-1)!;
    expect(last.headers.authorization).toBe(`Bearer ${DS_KEY}`);
    const bad = await post(body({ preset: 'deepseek', model: 'gpt-9-ultra' }));
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/not allowed/);
  });

  it('serves the mock preset from recordings', async () => {
    const r = await post(body({ preset: 'mock' }));
    expect(r.status).toBe(200);
    expect(r.json.response.text).toBe('recorded line');
  });

  it('validates the body', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ preset: 'anthropic' })).status).toBe(400);
    const r = await post(body({ request: { system: 's', messages: [{ role: 'system', content: 'x' }], purpose: 'p' } }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('request.messages.0.role');
    expect((await post(body({ model: 'bad model with spaces' }))).status).toBe(400);
    const wrongType = await fetch(`${base}/api/llm`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(415);
    expect((await fetch(`${base}/api/llm`)).status).toBe(405);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('rejects unknown and unconfigured presets', async () => {
    const unknown = await post(body({ preset: 'skynet' }));
    expect(unknown.status).toBe(404);
    const unconfigured = await post(body({ preset: 'mistral' }));
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.json.error.kind).toBe('config');
  });

  it('enforces the body size limit', async () => {
    const big = body({ request: { system: 'x'.repeat(5 * 1024 * 1024), messages: [{ role: 'user', content: 'x' }], purpose: 'p' } });
    const r = await post(big).catch(() => ({ status: 413 }) as { status: number });
    expect(r.status).toBe(413);
  });

  it('maps upstream errors without echoing keys', async () => {
    upstreamMode = 'auth';
    const a = await post(body());
    expect(a.status).toBe(502);
    expect(a.json.error.kind).toBe('auth');
    expect(JSON.stringify(a.json)).not.toContain(KEY);

    upstreamMode = 'rate';
    const r = await post(body());
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('600');
    expect(r.json.error.kind).toBe('rate_limit');
    const p = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base });
    expect(await p.complete(body().request as any).catch((e) => e)).toBeInstanceOf(LLMRateLimitError);
    upstreamMode = 'auth';
    expect(await p.complete(body().request as any).catch((e) => e)).toBeInstanceOf(LLMAuthError);

    upstreamMode = 'hang';
    const t = await post(body());
    expect(t.status).toBe(504);
    expect(t.json.error.kind).toBe('timeout');
    upstreamMode = 'ok';
  });
});

function rawGet(path: string): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('static files', () => {
  it('serves files with mime types, cache headers and SPA fallback', async () => {
    const idx = await fetch(`${base}/`);
    expect(idx.headers.get('content-type')).toContain('text/html');
    expect(await idx.text()).toContain('AnyWorld');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const css = await fetch(`${base}/style.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('no-cache');
    const spa = await fetch(`${base}/play/some-world`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('AnyWorld');
    expect((await fetch(`${base}/missing.png`)).status).toBe(404);
    for (const path of ['/../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/..%5c..%5cetc%5cpasswd.txt']) {
      const raw = await rawGet(path);
      expect(raw.body).not.toContain('root:');
      expect([200, 403, 404]).toContain(raw.status);
      if (raw.status === 200) expect(raw.body).toContain('AnyWorld'); // SPA fallback inside the root
    }
  });
});

describe('rate limiting', () => {
  it('token bucket allows a burst then refills', () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, burst: 2, now: () => t });
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(true);
    const denied = rl.take('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
    expect(rl.take('b').allowed).toBe(true);
    t += 1000;
    expect(rl.take('a').allowed).toBe(true);
  });

  it('returns 429 with retry-after once the per-IP budget is spent', async () => {
    const s = await startServer({
      port: 0,
      host: '127.0.0.1',
      env: { ANTHROPIC_API_KEY: KEY },
      fetch: upstream,
      rateLimit: { perMinute: 1, burst: 1 },
      recordings: [],
      log: () => {},
    });
    try {
      const url = `http://127.0.0.1:${s.port}/api/llm`;
      const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
      expect((await send()).status).toBe(200);
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await limited.json()).error.kind).toBe('rate_limit');
    } finally {
      await s.close();
    }
  });
});
