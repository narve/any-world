import { describe, it, expect } from 'vitest';
import { postJson, parseRetryAfter, redact, extractErrorMessage, isLocalTimeout, DEFAULT_BACKEND_TIMEOUT_MS, DEFAULT_SERVER_TOTAL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../../src/llm/http';
import {
  LLMAbortedError,
  LLMNetworkError,
  LLMTimeoutError,
  llmErrorFromJSON,
  LLMRateLimitError,
  LLMAuthError,
  isRetryable,
} from '../../src/llm/errors';
import { hangingFetch, json, mockFetch } from './helpers';

const args = { url: 'https://x.test/api', headers: {}, body: { a: 1 }, provider: 'test' };

describe('http helper', () => {
  it('times out with LLMTimeoutError', async () => {
    const err = await postJson(args, { fetch: hangingFetch, timeoutMs: 20, maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(isRetryable(err)).toBe(true);
  });

  it('honours the caller AbortSignal with LLMAbortedError and does not retry', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const err = await postJson({ ...args, signal: ac.signal }, { fetch: hangingFetch, timeoutMs: 5000, maxRetries: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMAbortedError);
    const pre = new AbortController();
    pre.abort();
    expect(await postJson({ ...args, signal: pre.signal }, { fetch: hangingFetch }).catch((e) => e)).toBeInstanceOf(LLMAbortedError);
  });

  it('maps fetch rejections to LLMNetworkError and retries them', async () => {
    let n = 0;
    const f = async () => {
      n++;
      throw new TypeError('fetch failed: ECONNREFUSED');
    };
    const err = await postJson(args, { fetch: f, maxRetries: 2, retryBaseMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMNetworkError);
    expect(n).toBe(3);
  });

  it('parses retry-after in seconds, ms and HTTP-date forms', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    const later = new Date(Date.now() + 10_000).toUTCString();
    const v = parseRetryAfter(new Headers({ 'retry-after': later }))!;
    expect(v).toBeGreaterThan(5000);
    expect(v).toBeLessThanOrEqual(10_000);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });

  it('redacts secrets and extracts error messages from different shapes', () => {
    expect(redact('key sk-123456 bad', ['sk-123456'])).toBe('key [redacted] bad');
    expect(redact('short', ['ab'])).toBe('short');
    expect(extractErrorMessage({ error: { type: 'x', message: 'm' } }, '')).toEqual({ message: 'm', code: 'x' });
    expect(extractErrorMessage({ error: 'plain' }, '').message).toBe('plain');
    expect(extractErrorMessage({ detail: 'd' }, '').message).toBe('d');
    expect(extractErrorMessage(undefined, 'raw text').message).toBe('raw text');
  });

  it('round-trips errors through JSON (backend transport)', () => {
    const e = new LLMRateLimitError('slow', { retryAfterMs: 5, status: 429 });
    const back = llmErrorFromJSON(e.toJSON());
    expect(back).toBeInstanceOf(LLMRateLimitError);
    expect(back.retryAfterMs).toBe(5);
    expect(llmErrorFromJSON({ kind: 'auth', message: 'x' })).toBeInstanceOf(LLMAuthError);
  });

  it('returns parsed JSON on success', async () => {
    const f = mockFetch(json({ ok: 1 }));
    expect((await postJson(args, { fetch: f })).json).toEqual({ ok: 1 });
    expect(f.calls[0]!.headers['content-type']).toBe('application/json');
  });
});

describe('http helper timeouts (M1 issue: timed-out calls were re-sent and billed again)', () => {
  const counting = () => {
    let n = 0;
    const f = ((_u: string, init?: RequestInit) => {
      n++;
      return new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }) as import('../../src/llm/http').FetchLike;
    return { f, count: () => n };
  };

  it('does not re-send a call our own timer gave up on', async () => {
    const { f, count } = counting();
    const err = await postJson(args, { fetch: f, timeoutMs: 20, maxRetries: 2, retryBaseMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(isLocalTimeout(err)).toBe(true);
    expect(count()).toBe(1);
  });

  it('retries local timeouts only when asked to', async () => {
    const { f, count } = counting();
    await postJson(args, { fetch: f, timeoutMs: 10, maxRetries: 2, retryBaseMs: 1, retryOnTimeout: true }).catch((e) => e);
    expect(count()).toBe(3);
  });

  it('still retries an upstream 408', async () => {
    const f = mockFetch(json({ error: { message: 'slow' } }, 408), json({ ok: true }));
    const r = await postJson(args, { fetch: f, maxRetries: 2, retryBaseMs: 1 });
    expect(r.json).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
    expect(isLocalTimeout(new LLMTimeoutError('x', { status: 408 }))).toBe(false);
  });

  it('keeps attempts and backoff inside totalTimeoutMs', async () => {
    const { f, count } = counting();
    const t0 = Date.now();
    const err = await postJson(args, { fetch: f, timeoutMs: 10_000, totalTimeoutMs: 60, retryOnTimeout: true, maxRetries: 5, retryBaseMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
    // a 5xx whose backoff would overrun the deadline is surfaced instead of retried
    const s = mockFetch(json({ error: { message: 'down' } }, 503));
    const e2 = await postJson(args, { fetch: s, totalTimeoutMs: 50, retryBaseMs: 500, maxRetries: 3 }).catch((e) => e);
    expect(e2.kind).toBe('server');
    expect(s.calls).toHaveLength(1);
    expect(count()).toBeGreaterThanOrEqual(1);
  });

  it('the backend client waits longer than the server budget by default', () => {
    expect(DEFAULT_BACKEND_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SERVER_TOTAL_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
  });
});
