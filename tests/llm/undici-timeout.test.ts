/**
 * M1 issue: Node's fetch (undici) cut every upstream call at its built-in 300 s headers/body timeout,
 * which was filed as a retryable network error, so a slow generation was sent (and billed) 2-3 times.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLocalTimeout, LOCAL_TIMEOUT_CODE, longCallDispatcher, postJson, undiciTimeoutCode } from '../../src/llm/http';
import { LLMNetworkError, LLMTimeoutError } from '../../src/llm/errors';
import { AnthropicProvider } from '../../src/llm/anthropic';
import { fastRetry, json, mockFetch } from './helpers';

const args = { url: 'https://up.example/v1', headers: {}, body: {}, provider: 'anthropic' };

function undiciError(code: string): TypeError {
  const cause = Object.assign(new Error(code === 'UND_ERR_HEADERS_TIMEOUT' ? 'Headers Timeout Error' : 'Body Timeout Error'), { code });
  return new TypeError('fetch failed', { cause });
}

describe('undici built-in timeouts are client timeouts, not network errors', () => {
  it('finds the code anywhere in the cause chain', () => {
    expect(undiciTimeoutCode(undiciError('UND_ERR_HEADERS_TIMEOUT'))).toBe('UND_ERR_HEADERS_TIMEOUT');
    expect(undiciTimeoutCode(new TypeError('terminated', { cause: undiciError('UND_ERR_BODY_TIMEOUT') }))).toBe('UND_ERR_BODY_TIMEOUT');
    expect(undiciTimeoutCode(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }))).toBeUndefined();
    expect(undiciTimeoutCode('nope')).toBeUndefined();
  });

  it('a headers timeout is an LLMTimeoutError (local code) and is sent exactly once', async () => {
    let calls = 0;
    const f = async (): Promise<Response> => {
      calls++;
      throw undiciError('UND_ERR_HEADERS_TIMEOUT');
    };
    const err = await postJson(args, { fetch: f, maxRetries: 2, ...fastRetry }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err).not.toBeInstanceOf(LLMNetworkError);
    expect(err.code).toBe(LOCAL_TIMEOUT_CODE);
    expect(isLocalTimeout(err)).toBe(true);
    expect(calls).toBe(1);
  });

  it('a body timeout while reading the response is handled the same way', async () => {
    let calls = 0;
    const f = async (): Promise<Response> => {
      calls++;
      const body = new ReadableStream({
        pull(c) {
          c.error(new TypeError('terminated', { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) }));
        },
      });
      return new Response(body, { status: 200 });
    };
    const err = await postJson(args, { fetch: f, maxRetries: 2, ...fastRetry }).catch((e) => e);
    expect(isLocalTimeout(err)).toBe(true);
    expect(calls).toBe(1);
  });

  it('follows retryOnTimeout like our own timer does', async () => {
    let calls = 0;
    const f = async (): Promise<Response> => {
      calls++;
      if (calls === 1) throw undiciError('UND_ERR_HEADERS_TIMEOUT');
      return json({ ok: true });
    };
    const r = await postJson(args, { fetch: f, maxRetries: 2, retryOnTimeout: true, ...fastRetry });
    expect(r.json).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('through a provider: one upstream call, timeout error', async () => {
    const f = mockFetch(() => {
      throw undiciError('UND_ERR_HEADERS_TIMEOUT');
    });
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, maxRetries: 2, ...fastRetry })
      .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], purpose: 't' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(f.calls).toHaveLength(1);
  });

  it('passes an explicit dispatcher to an injected fetch, and none by default', async () => {
    const f = mockFetch(json({ ok: 1 }));
    let seen: unknown[] = [];
    const spy = (u: string, init?: RequestInit) => {
      seen.push((init as { dispatcher?: unknown }).dispatcher);
      return f(u, init);
    };
    const marker = { marker: true };
    await postJson(args, { fetch: spy });
    await postJson(args, { fetch: spy, dispatcher: marker });
    await postJson(args, { fetch: spy, dispatcher: false });
    expect(seen).toEqual([undefined, marker, undefined]);
    seen = [];
  });
});

describe("Node's real fetch: undici's own headers timeout no longer cuts our calls", () => {
  const SYM = Symbol.for('undici.globalDispatcher.1');
  const g = globalThis as Record<symbol, unknown>;
  let original: unknown;
  let server: http.Server;
  let url = '';
  let hits = 0;

  beforeAll(async () => {
    original = g[SYM];
    const Ctor = (original as { constructor: new (o: object) => unknown }).constructor;
    // a global dispatcher with a short headers timeout stands in for undici's 300 s default
    g[SYM] = new Ctor({ headersTimeout: 500, bodyTimeout: 500 });
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }, 2500);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    const replaced = g[SYM] as { close?: () => Promise<void> };
    g[SYM] = original;
    await replaced.close?.().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('the global dispatcher alone would cut the call (sanity check)', async () => {
    const err = await fetch(url, { method: 'POST', body: '{}' }).catch((e) => e);
    expect(undiciTimeoutCode(err)).toBe('UND_ERR_HEADERS_TIMEOUT');
  });

  it('postJson waits for the slow upstream (our timer bounds it, not undici)', async () => {
    expect(longCallDispatcher()).toBeDefined();
    hits = 0;
    const r = await postJson({ ...args, url }, { timeoutMs: 20_000, maxRetries: 2 });
    expect(r.json).toEqual({ ok: true });
    expect(hits).toBe(1);
  }, 15_000);

  it('without the lifted dispatcher the cut is a timeout, sent once despite maxRetries 2', async () => {
    hits = 0;
    const err = await postJson({ ...args, url }, { timeoutMs: 20_000, maxRetries: 2, dispatcher: false, ...fastRetry }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(isLocalTimeout(err)).toBe(true);
    expect(hits).toBe(1);
  }, 15_000);
});
