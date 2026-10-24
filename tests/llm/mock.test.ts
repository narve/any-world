import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, parseRecordingsFile } from '../../src/llm/mock';
import { loadRecordingsFromDir } from '../../src/llm/recordings-node';
import { requestHash, stableStringify } from '../../src/llm/hash';
import { LLMAbortedError, LLMInvalidResponseError, LLMRateLimitError, LLMServerError, LLMTimeoutError, LLMNetworkError, LLMRefusalError } from '../../src/llm/errors';

const req = (purpose: string, content = 'x') => ({ system: 's', messages: [{ role: 'user' as const, content }], purpose });

describe('request hashing', () => {
  it('is stable across key order and ignores signal/maxTokens', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const a = requestHash({ ...req('w'), maxTokens: 10 });
    const b = requestHash({ ...req('w'), signal: new AbortController().signal });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(requestHash(req('w', 'y'))).not.toBe(a);
  });
});

describe('MockProvider', () => {
  it('prefers exact hash, then purpose, then purpose prefix, then fallback', async () => {
    const r = req('gm:area_enter', 'special');
    const mock = new MockProvider({
      recordings: [
        { purpose: 'gm:area_enter', hash: requestHash(r), text: 'exact' },
        { purpose: 'gm:area_enter', text: 'by purpose' },
        { purpose: 'gm', json: { say: 'by prefix' } },
      ],
      fallback: (q) => (q.purpose === 'dialogue' ? 'generated' : undefined),
    });
    expect((await mock.complete(r)).text).toBe('exact');
    expect((await mock.complete(req('gm:area_enter', 'other'))).text).toBe('by purpose');
    expect((await mock.complete(req('gm:item_use'))).text).toBe('{"say":"by prefix"}');
    expect((await mock.complete(req('dialogue'))).text).toBe('generated');
    expect(await mock.complete(req('world')).catch((e) => e)).toBeInstanceOf(LLMInvalidResponseError);
    expect(mock.calls).toHaveLength(5);
  });

  it('serves multiple responses in order, repeating the last', async () => {
    const mock = new MockProvider({ responses: { w: ['one', 'two'] } });
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await mock.complete(req('w'))).text);
    expect(texts).toEqual(['one', 'two', 'two']);
    mock.add({ purpose: 'late', text: 'added' });
    expect((await mock.complete(req('late'))).text).toBe('added');
    expect(mock.count('w')).toBe(2);
  });

  it('can disable prefix matching', async () => {
    const mock = new MockProvider({ responses: { gm: 'x' }, matchPrefix: false });
    expect(await mock.complete(req('gm:a')).catch((e) => e)).toBeInstanceOf(LLMInvalidResponseError);
  });

  it('injects failures: failFirst, every mode, purpose filter', async () => {
    const mock = new MockProvider({ responses: { w: 'ok', d: 'ok' }, failure: { mode: 'server', failFirst: 2, purposes: ['w'] } });
    expect((await mock.complete(req('d'))).text).toBe('ok'); // not targeted
    expect(await mock.complete(req('w')).catch((e) => e)).toBeInstanceOf(LLMServerError);
    expect(await mock.complete(req('w')).catch((e) => e)).toBeInstanceOf(LLMServerError);
    expect((await mock.complete(req('w'))).text).toBe('ok');

    const cases = [
      ['rate_limit', LLMRateLimitError],
      ['network', LLMNetworkError],
      ['timeout', LLMTimeoutError],
      ['refusal', LLMRefusalError],
    ] as const;
    for (const [mode, cls] of cases) {
      const m = new MockProvider({ responses: { w: 'ok' }, failure: { mode, failFirst: 1, retryAfterMs: 7 } });
      const e = await m.complete(req('w')).catch((x) => x);
      expect(e).toBeInstanceOf(cls);
      if (mode === 'rate_limit') expect(e.retryAfterMs).toBe(7);
    }
    const bad = new MockProvider({ responses: { w: 'ok' }, failure: { mode: 'invalid_json', failFirst: 1 } });
    expect((await bad.complete(req('w'))).text).toContain('not valid json');
  });

  it('probabilistic failures are deterministic for a seed', async () => {
    const run = async () => {
      const m = new MockProvider({ responses: { w: 'ok' }, failure: { mode: 'server', probability: 0.5, seed: 42 } });
      const out: boolean[] = [];
      for (let i = 0; i < 20; i++) out.push(await m.complete(req('w')).then(() => true, () => false));
      return out;
    };
    const a = await run();
    expect(a).toEqual(await run());
    expect(a.filter(Boolean).length).toBeGreaterThan(2);
    expect(a.filter((x) => !x).length).toBeGreaterThan(2);
  });

  it('applies latency and honours abort during it', async () => {
    const mock = new MockProvider({ responses: { w: 'ok' }, latencyMs: 40 });
    const t0 = Date.now();
    await mock.complete(req('w'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    expect(await mock.complete({ ...req('w'), signal: ac.signal }).catch((e) => e)).toBeInstanceOf(LLMAbortedError);
    const ranged = new MockProvider({ responses: { w: 'ok' }, latencyMs: [1, 5] });
    expect((await ranged.complete(req('w'))).text).toBe('ok');
  });

  it('loads recordings from a directory in all file shapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ purpose: 'world', json: { title: 'A' } }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([{ purpose: 'gm', text: 'hi' }, { nope: 1 }]));
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ recordings: [{ purpose: 'dialogue', text: 'yo' }] }));
    writeFileSync(join(dir, 'ignore.txt'), 'x');
    const recs = await loadRecordingsFromDir(dir);
    expect(recs.map((r) => r.purpose)).toEqual(['world', 'gm', 'dialogue']);
    expect(await loadRecordingsFromDir(join(dir, 'missing'))).toEqual([]);
    expect(parseRecordingsFile({ purpose: 'x' })).toEqual([]);
    writeFileSync(join(dir, 'd.json'), '{oops');
    await expect(loadRecordingsFromDir(dir)).rejects.toThrow(/d\.json/);
  });
});

describe('MockProvider call log bounds (M1 issue: server mock kept every request forever)', () => {
  const r = (i: number) => ({ system: 's', messages: [{ role: 'user' as const, content: `m${i}` }], purpose: 'dialogue' });

  it('keeps every call by default (tests rely on it)', async () => {
    const m = new MockProvider({ responses: { dialogue: 'x' } });
    for (let i = 0; i < 5; i++) await m.complete(r(i));
    expect(m.calls).toHaveLength(5);
    expect(m.callCount).toBe(5);
  });

  it('maxCalls 0 keeps nothing; maxCalls N keeps the latest N', async () => {
    const none = new MockProvider({ responses: { dialogue: 'x' }, maxCalls: 0 });
    for (let i = 0; i < 50; i++) await none.complete(r(i));
    expect(none.calls).toHaveLength(0);
    expect(none.callCount).toBe(50);
    const ring = new MockProvider({ responses: { dialogue: 'x' }, maxCalls: 3 });
    for (let i = 0; i < 10; i++) await ring.complete(r(i));
    expect(ring.calls.map((c) => c.messages[0]!.content)).toEqual(['m7', 'm8', 'm9']);
  });
});
