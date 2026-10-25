/**
 * MP0 home hosting: the host access code on POST /api/llm and CORS for pages hosted elsewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from '../../server/index';
import { codeMatches, parseAllowedOrigins, HOST_CODE_HEADER } from '../../server/app';
import { createProvider } from '../../src/llm/transport';
import { LLMAuthError } from '../../src/llm/errors';
import { anthropicMessage, json, mockFetch } from '../llm/helpers';

const CODE = 'otter-lantern-42';
const PAGES = 'https://narve.github.io';
const upstream = mockFetch(() => json(anthropicMessage('hi')));

let base = '';
let close: () => Promise<void>;
const logs: string[] = [];

beforeAll(async () => {
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    env: { ANTHROPIC_API_KEY: 'sk-ant-x', ANYWORLD_HOST_CODE: CODE, ALLOWED_ORIGINS: `${PAGES}, not a url, https://anyworld.dv8.no/some/path` },
    fetch: upstream,
    upstream: { maxRetries: 0, timeoutMs: 300 },
    rateLimit: { perMinute: 600, burst: 50 },
    log: (l) => logs.push(l),
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});
afterAll(() => close());

const llmBody = (preset = 'anthropic') => JSON.stringify({ preset, request: { system: 's', messages: [{ role: 'user', content: 'x' }], purpose: 'dialogue' } });
const post = (headers: Record<string, string> = {}, preset?: string) =>
  fetch(`${base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: llmBody(preset) });

describe('host access code', () => {
  it('refuses AI calls without the code, and with a wrong one', async () => {
    const none = await post();
    expect(none.status).toBe(401);
    expect((await none.json()).error.message).toMatch(/access code/);
    const wrong = await post({ [HOST_CODE_HEADER]: 'nope' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.message).toBe('Wrong server access code');
    expect(logs.some((l) => l.includes('refused: missing access code'))).toBe(true);
  });

  it('accepts the right code (surrounding spaces ignored)', async () => {
    const ok = await post({ [HOST_CODE_HEADER]: ` ${CODE} ` });
    expect(ok.status).toBe(200);
    expect((await ok.json()).response.text).toBe('hi');
  });

  it('keeps the recorded "mock" preset open (it costs nothing)', async () => {
    const r = await post({}, 'mock');
    expect(r.status).not.toBe(401);
  });

  it('tells clients a code is needed, and never the code itself', async () => {
    const r = await fetch(`${base}/api/presets`);
    const text = await r.text();
    expect(JSON.parse(text).codeRequired).toBe(true);
    expect(text).not.toContain(CODE);
  });

  it('the backend provider sends the code it was given and types the refusal as auth', async () => {
    const good = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base, backendHeaders: { [HOST_CODE_HEADER]: CODE } });
    expect((await good.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], purpose: 'dialogue' })).text).toBe('hi');
    const bad = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base });
    await expect(bad.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], purpose: 'dialogue' })).rejects.toBeInstanceOf(LLMAuthError);
  });

  it('codeMatches compares exactly', () => {
    expect(codeMatches(CODE, CODE)).toBe(true);
    expect(codeMatches(`${CODE}x`, CODE)).toBe(false);
    expect(codeMatches(undefined, CODE)).toBe(false);
  });
});

describe('CORS for pages hosted elsewhere', () => {
  it('parses ALLOWED_ORIGINS to origins, dropping junk', () => {
    expect(parseAllowedOrigins(`${PAGES}, not a url, https://anyworld.dv8.no/some/path, ftp://x`)).toEqual([PAGES, 'https://anyworld.dv8.no']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('answers the preflight for a listed origin, with the code header allowed', async () => {
    const r = await fetch(`${base}/api/llm`, { method: 'OPTIONS', headers: { origin: PAGES, 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(r.headers.get('access-control-allow-headers')).toContain(HOST_CODE_HEADER);
  });

  it('refuses the preflight for any other origin and sends no allow header', async () => {
    const r = await fetch(`${base}/api/llm`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const g = await fetch(`${base}/api/presets`, { headers: { origin: 'https://evil.example' } });
    expect(g.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds the allow header to real responses for a listed origin, errors included', async () => {
    const g = await fetch(`${base}/api/presets`, { headers: { origin: 'https://anyworld.dv8.no' } });
    expect(g.headers.get('access-control-allow-origin')).toBe('https://anyworld.dv8.no');
    const p = await post({ origin: PAGES });
    expect(p.status).toBe(401);
    expect(p.headers.get('access-control-allow-origin')).toBe(PAGES);
  });
});
