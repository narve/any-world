/**
 * A server open to everyone: the proof-of-work pass and the daily budget on POST /api/llm (llm-guard.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from '../../server/index';
import { DailyBudget, ProofOfWork, PASS_HEADER } from '../../server/llm-guard';
import { createProvider, DAILY_BUDGET_CODE, PASS_REQUIRED_CODE } from '../../src/llm/transport';
import { createPassAuth, solveChallenge } from '../../src/llm/pass';
import { LLMAuthError, LLMRateLimitError } from '../../src/llm/errors';
import { anthropicMessage, json, mockFetch } from '../llm/helpers';

const req = { system: 's', messages: [{ role: 'user' as const, content: 'x' }], purpose: 'dialogue' };

describe('ProofOfWork', () => {
  it('gives one pass per correct answer, and none for a wrong, replayed or late one', async () => {
    let t = 1_000_000;
    const pow = new ProofOfWork({ maxNumber: 300, now: () => t });
    const c = pow.challenge();
    const n = await solveChallenge(c);
    expect(n).not.toBeNull();
    const sol = { salt: c.salt, number: n!, challenge: c.challenge, signature: c.signature };
    expect(pow.redeem({ ...sol, number: n! + 1 })).toBeNull();
    expect(pow.redeem({ ...sol, signature: '0'.repeat(64) })).toBeNull();
    const out = pow.redeem(sol);
    expect(out && pow.valid(out.pass)).toBe(true);
    expect(pow.redeem(sol)).toBeNull();

    const late = pow.challenge();
    const m = await solveChallenge(late);
    t += 11 * 60_000;
    expect(pow.redeem({ salt: late.salt, number: m!, challenge: late.challenge, signature: late.signature })).toBeNull();
  });

  it('a pass expires, and a pass from another process (key) is refused', async () => {
    let t = 0;
    const pow = new ProofOfWork({ maxNumber: 50, passTtlMs: 1000, now: () => t });
    const c = pow.challenge();
    const out = pow.redeem({ ...c, number: (await solveChallenge(c))! })!;
    expect(pow.valid(out.pass)).toBe(true);
    expect(new ProofOfWork({ maxNumber: 50, now: () => t }).valid(out.pass)).toBe(false);
    expect(pow.valid(out.pass.replace(/^\d+/, '99999999'))).toBe(false);
    t = 1001;
    expect(pow.valid(out.pass)).toBe(false);
  });
});

describe('DailyBudget', () => {
  it('caps calls and tokens per UTC day', () => {
    let t = Date.UTC(2026, 10, 1, 23, 0);
    const b = new DailyBudget({ calls: 2, tokens: 100, now: () => t });
    expect(b.take()).toBe(true);
    b.spend(60);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.msToReset()).toBe(3600_000);
    t += 3600_000;
    expect(b.take()).toBe(true);
    b.spend(150);
    expect(b.take()).toBe(false);
    expect(b.usage()).toEqual({ day: '2026-11-02', calls: 1, tokens: 150 });
  });

  it('without limits it never refuses', () => {
    const b = new DailyBudget({});
    expect(b.capped).toBe(false);
    for (let i = 0; i < 100; i++) expect(b.take()).toBe(true);
  });
});

describe('an open server with a pass and a daily budget', () => {
  let base = '';
  let close: () => Promise<void>;
  const logs: string[] = [];

  beforeAll(async () => {
    const s = await startServer({
      port: 0,
      host: '127.0.0.1',
      env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      fetch: mockFetch(() => json(anthropicMessage('hi'))),
      upstream: { maxRetries: 0, timeoutMs: 300 },
      rateLimit: { perMinute: 600, burst: 50 },
      pow: { maxNumber: 200 },
      dailyBudget: { calls: 3 },
      log: (l) => logs.push(l),
    });
    base = `http://127.0.0.1:${s.port}`;
    close = s.close;
  });
  afterAll(() => close());

  it('tells clients a pass is needed', async () => {
    const info = await (await fetch(`${base}/api/presets`)).json();
    expect(info.passRequired).toBe(true);
    expect(info.codeRequired).toBe(false);
  });

  it('refuses AI calls without a pass (typed pass_required), keeps "mock" open', async () => {
    const bare = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base });
    const e = await bare.complete(req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMAuthError);
    expect((e as LLMAuthError).code).toBe(PASS_REQUIRED_CODE);
    const fake = await fetch(`${base}/api/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PASS_HEADER]: `${Date.now() + 1e6}.abc.${'0'.repeat(64)}` },
      body: JSON.stringify({ preset: 'anthropic', request: req }),
    });
    expect(fake.status).toBe(401);
    const mock = await fetch(`${base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'mock', request: req }) });
    expect(mock.status).not.toBe(401);
  });

  it('a client with a pass gets answers until the day is used up, then a typed budget refusal', async () => {
    const auth = createPassAuth(base);
    const p = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base, backendAuth: auth });
    for (let i = 0; i < 3; i++) expect((await p.complete(req)).text).toBe('hi');
    const e = await p.complete(req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMRateLimitError);
    expect((e as LLMRateLimitError).code).toBe(DAILY_BUDGET_CODE);
    expect((e as LLMRateLimitError).retryAfterMs).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('daily budget used up'))).toBe(true);
  });

  it('a refused pass is renewed once', async () => {
    let calls = 0;
    const auth = createPassAuth(base);
    const stale = { headers: async () => (calls++ === 0 ? { [PASS_HEADER]: 'stale' } : auth.headers()), invalidate: () => auth.invalidate() };
    const p = createProvider({ preset: 'anthropic', transport: 'backend' }, { backendUrl: base, backendAuth: stale });
    // the budget is used up by now, so the renewed call reaches the budget check: proof it got past the pass
    await expect(p.complete(req)).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(calls).toBe(2);
  });
});
