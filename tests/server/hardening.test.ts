import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { startServer } from '../../server/index';
import { clientIpFrom, parseTrustProxy } from '../../server/app';

/** send raw bytes, resolve with the full response text (until the server closes or 2 s pass) */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let out = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, 2000);
    sock.on('data', (d) => (out += d.toString('utf8')));
    sock.on('end', () => {
      clearTimeout(timer);
      resolve(out);
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      if (out) resolve(out);
      else reject(e);
    });
    sock.write(payload);
  });
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('server: malformed request targets', () => {
  it('answers 400 to invalid absolute-form targets and keeps serving', async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      const s = await startServer({ port: 0, host: '127.0.0.1', env: {}, recordings: [], log: () => {} });
      close = s.close;
      for (const target of ['http://[', 'http://a:99999/', '//[x']) {
        const text = await raw(s.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        expect(text, target).toMatch(/^HTTP\/1\.1 400 /);
        expect(text).toContain('Invalid request target');
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
      const health = await fetch(`http://127.0.0.1:${s.port}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});

describe('server: client IP behind a reverse proxy', () => {
  it('parses TRUST_PROXY as a hop count', () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('false')).toBe(0);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('true')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('-1')).toBe(0);
    expect(parseTrustProxy('abc')).toBe(0);
  });

  it('uses the entry the trusted proxy appended, never the client-supplied left-most one', () => {
    expect(clientIpFrom('10.9.9.1, 203.0.113.7', '127.0.0.1', 1)).toBe('203.0.113.7');
    expect(clientIpFrom(['10.9.9.1', '203.0.113.7'], '127.0.0.1', 1)).toBe('203.0.113.7');
    expect(clientIpFrom('10.9.9.1, 203.0.113.7, 10.0.0.2', '127.0.0.1', 2)).toBe('203.0.113.7');
    expect(clientIpFrom('203.0.113.7', '127.0.0.1', 3)).toBe('203.0.113.7');
    expect(clientIpFrom('10.9.9.1, 203.0.113.7', '127.0.0.1', 0)).toBe('127.0.0.1');
    expect(clientIpFrom(undefined, '127.0.0.1', 1)).toBe('127.0.0.1');
    expect(clientIpFrom('not-an-ip', '127.0.0.1', 1)).toBe('127.0.0.1');
    expect(clientIpFrom('::1, 2001:db8::5', '127.0.0.1', 1)).toBe('2001:db8::5');
  });

  async function statuses(env: Record<string, string>, xff: (i: number) => string, n: number): Promise<number[]> {
    const s = await startServer({ port: 0, host: '127.0.0.1', env, recordings: [], log: () => {} });
    close = s.close;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff(i) },
        body: JSON.stringify({ preset: 'mock', request: { system: 's', messages: [{ role: 'user', content: 'hi' }], purpose: 'test' } }),
      });
      await res.text();
      out.push(res.status);
    }
    return out;
  }

  it('a spoofed left-most X-Forwarded-For entry does not bypass the rate limit', async () => {
    const env = { TRUST_PROXY: '1', LLM_RATE_BURST: '2', LLM_RATE_PER_MIN: '1' };
    const got = await statuses(env, (i) => `10.9.9.${i}, 203.0.113.7`, 6);
    expect(got.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(got.slice(2)).toEqual([429, 429, 429, 429]);
  });

  it('distinct real clients (as appended by the proxy) still get separate buckets', async () => {
    const env = { TRUST_PROXY: '1', LLM_RATE_BURST: '1', LLM_RATE_PER_MIN: '1' };
    const got = await statuses(env, (i) => `1.1.1.1, 203.0.113.${i}`, 3);
    expect(got).not.toContain(429);
  });
});
