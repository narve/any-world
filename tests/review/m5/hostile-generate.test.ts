/**
 * M5 review (balance & robustness, round 1): the world-generation pipeline fed hostile replies by
 * the mock provider. Whatever the model sends, generateWorld must either return a valid world or
 * throw a typed WorldGenerationError — never crash with a TypeError/RangeError, hang, or pollute
 * Object.prototype.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MockProvider } from '../../../src/llm/mock';
import { generateWorld, checkWorldReply, peekTitle, WorldGenerationError } from '../../../src/llm/generate';
import { extractJson } from '../../../src/llm/structured';

const fixture = () => JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8')) as Record<string, any>;

async function outcome(replies: unknown[], balance: false | { seeds: number; rounds: number; confirm: boolean } = false) {
  const mock = new MockProvider({ responses: { world: replies.map((r) => (typeof r === 'string' ? r : { text: JSON.stringify(r) })) as never } });
  try {
    const res = await generateWorld({ provider: mock, prompt: 'x', balance, repairs: replies.length - 1, balanceFeedback: 0, yieldToUi: async () => {}, timeoutMs: 60_000 });
    return { ok: true as const, res, calls: mock.calls.length };
  } catch (e) {
    expect(e).toBeInstanceOf(WorldGenerationError);
    return { ok: false as const, err: e as WorldGenerationError, calls: mock.calls.length };
  }
}

afterEach(() => {
  // nothing a reply contains may leak onto Object.prototype
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
});

describe('hostile replies to generateWorld never crash', () => {
  const wrongTypes: [string, unknown][] = [
    ['null', null],
    ['number', 42],
    ['string', 'a world'],
    ['array', [fixture()]],
    ['bool', true],
    ['empty object', {}],
    ['meta as array', { ...fixture(), meta: [] }],
    ['areas as object', { ...fixture(), areas: { 0: fixture().areas[0] } }],
    ['actors null', { ...fixture(), actors: null }],
    ['stats as strings', (() => { const w = fixture(); w.actors[0].stats.hp = '12'; return w; })()],
    ['NaN-ish numbers', (() => { const w = fixture(); w.player.stats.hp = 1e400; return w; })()],
  ];
  for (const [name, v] of wrongTypes) {
    it(`wrong type: ${name}`, async () => {
      const r = await outcome([v, v]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.err.kind).toBe('invalid');
        expect(r.err.errors.length).toBeGreaterThan(0);
        expect(r.calls).toBe(2);
      }
    });
  }

  it('prototype keys: __proto__ / constructor / prototype payloads do not pollute', async () => {
    const w = fixture();
    const text = JSON.stringify(w).replace(/^\{/, '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},');
    const withMeta = text.replace('"meta":{', '"meta":{"__proto__":{"polluted":2},');
    const r = await outcome([withMeta]);
    // extra keys are stripped: the reply is otherwise valid
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.res.world)).toBe(Object.prototype);
      expect((r.res.world as Record<string, unknown>).polluted).toBeUndefined();
      expect((r.res.world.meta as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it('generator params with prototype keys and absurd values are accepted but harmless', async () => {
    const w = fixture();
    w.areas[0].params = JSON.parse('{"__proto__":5,"constructor":1e308,"roomCount":-1e308,"openness":1e308}');
    const r = await outcome([w], { seeds: 2, rounds: 0, confirm: false });
    expect(r.ok || r.err.kind === 'unbalanced').toBe(true);
  }, 120_000);

  it('references to missing ids are reported, not thrown', async () => {
    const w = fixture();
    w.areas[0].actors[0].actor = 'ghost';
    w.areas[0].placedItems = [{ item: 'nothing-here', where: 'near_exit' }];
    w.player.startingItems.push({ item: 'missing-thing', count: 1 });
    w.goal.win = { type: 'actor_defeated', actor: 'nobody' };
    w.player.growth.perks[0].grantItems = ['nope'];
    const r = await outcome([w, w]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.err.errors.join('\n');
      expect(all).toMatch(/ghost/);
      expect(all).toMatch(/nobody/);
    }
  });

  it('a max-size reply (~128 kB, the 32k-token cap, of unbalanced junk around a valid world) is handled', async () => {
    const junk = '{'.repeat(32_000) + ' blah ' + '['.repeat(32_000);
    const t0 = Date.now();
    const r = await outcome([junk + '\n' + JSON.stringify(fixture()) + '\n' + junk, JSON.stringify(fixture())]);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // either the world is found or the model is asked again; both are fine, crashing is not
    expect(r.ok).toBe(true);
  }, 60_000);

  it('deeply nested JSON does not overflow the stack', async () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    const deepObj = '{"meta":' + '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000) + '}';
    const r = await outcome([deep, deepObj]);
    expect(r.ok).toBe(false);
  }, 60_000);

  it('very large arrays (10k actors) are rejected by limits, not by a crash', async () => {
    const w = fixture();
    const a0 = w.actors[0];
    w.actors = Array.from({ length: 10_000 }, (_, i) => ({ ...a0, id: `a${i}` }));
    const t0 = Date.now();
    const r = await outcome([w]);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.ok).toBe(false);
  }, 60_000);

  it('weird strings: lone surrogates, NUL, RTL, 1 MB title', async () => {
    const w = fixture();
    w.meta.title = '\ud800\u0000‮' + 'x'.repeat(1_000_000);
    const r = await outcome([w]);
    expect(r.ok).toBe(false);
    expect(peekTitle(JSON.stringify(w)).title!.length).toBeLessThanOrEqual(60);
  });

  it('thinking tags, fences and prose around the JSON', async () => {
    const text = '<think>{"nope": ```</think>Sure! ```json\n' + JSON.stringify(fixture()) + '\n``` hope that helps {';
    const r = await outcome([text]);
    expect(r.ok).toBe(true);
  });

  it('unbalanced fences / NUL junk fail cleanly', async () => {
    for (const t of ['```json\n{"meta":', '```'.repeat(10_000), '\u0000'.repeat(1000)]) {
      const ex = extractJson(t);
      expect(typeof ex.ok).toBe('boolean');
      const c = await checkWorldReply(t);
      expect(c.ok).toBe(false);
    }
  });
});
