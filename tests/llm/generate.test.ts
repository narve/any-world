import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MockProvider } from '../../src/llm/mock';
import { LLMAuthError, LLMRateLimitError } from '../../src/llm/errors';
import type { CompletionRequest, LLMProvider } from '../../src/llm/types';
import {
  generateWorld,
  checkWorldReply,
  finaliseWorld,
  peekTitle,
  balanceFeedbackMessage,
  WorldGenerationError,
  WORLD_JSON_HINT_SCHEMA,
  type GenerateProgress,
  type Balancer,
} from '../../src/llm/generate';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';

const raw = (name: string) => JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')) as Record<string, any>;
const parsed = (name: string): WorldSpec => {
  const r = parseWorld(raw(name));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
};

/** a copy of the teen fixture with a zod error and two reference errors */
function brokenTeen(): Record<string, any> {
  const w = structuredClone(raw('fixture-teen'));
  w.items[0].useMode = 'charges'; // refs: charges required
  w.areas[0].actors[0].actor = 'no-such-actor'; // refs: unknown actor
  w.actors[1].stats.hp = 0; // zod: hp >= 1
  return w;
}

async function expectGenError(p: Promise<unknown>): Promise<WorldGenerationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WorldGenerationError);
    return e as WorldGenerationError;
  }
  throw new Error('expected a WorldGenerationError');
}

describe('generateWorld (mock provider)', () => {
  it('a valid fixture reply: one call, meta from the request, balance report, progress stages', async () => {
    const mock = new MockProvider({ responses: { world: { text: 'Here is your world:\n```json\n' + JSON.stringify(raw('fixture-ship')) + '\n```' } } });
    const progress: GenerateProgress[] = [];
    const res = await generateWorld({
      provider: mock,
      prompt: '  a moss-grown generation ship  ',
      language: 'nb',
      balance: { seeds: 3, rounds: 0, confirm: false },
      onProgress: (p) => progress.push(p),
      yieldToUi: async () => {},
    });
    expect(res.attempts).toBe(1);
    expect(res.world.meta.title).toBe('The Long Quiet of the Halcyon Tithe');
    expect(res.world.meta.language).toBe('nb');
    expect(res.world.meta.prompt).toBe('a moss-grown generation ship');
    expect(res.report).not.toBeNull();
    expect(res.report!.sims.map((s) => s.runs)).toEqual([3, 3]);
    expect(['ok', 'too_hard', 'too_easy']).toContain(res.report!.verdict);
    const stages = progress.map((p) => p.stage);
    expect(stages).toEqual(['request', 'received', 'validated', 'balancing', 'done']);
    expect(progress.find((p) => p.stage === 'received')!.title).toBe('The Long Quiet of the Halcyon Tithe');
    expect(progress.every((p) => p.key.startsWith('gen.progress.'))).toBe(true);
    expect(progress.at(-1)!.fraction).toBe(1);

    const req = mock.calls[0]!;
    expect(req.purpose).toBe('world');
    expect(req.jsonSchema).toEqual(WORLD_JSON_HINT_SCHEMA);
    expect(req.schemaInPrompt).toBe(false);
    expect(req.maxTokens).toBe(32_000);
    expect(req.system).toContain('type WorldSpec =');
    expect(req.system).toContain('Norwegian Bokmål');
    expect(req.messages[0]!.content).toContain('a moss-grown generation ship');
  });

  it('repairs an invalid world: the validation errors go back to the model', async () => {
    const mock = new MockProvider({ responses: { world: [{ json: brokenTeen() }, { json: raw('fixture-teen') }] } });
    const progress: GenerateProgress[] = [];
    const res = await generateWorld({ provider: mock, prompt: 'teen drama', balance: false, onProgress: (p) => progress.push(p) });
    expect(res.attempts).toBe(2);
    expect(res.report).toBeNull();
    expect(res.world.meta.title).toBe('Lowmoor Goes Under');
    const second = mock.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]!.role).toBe('assistant');
    const repair = second.messages[2]!.content;
    expect(repair).toContain('Your previous reply could not be used. Problems found:');
    expect(repair).toMatch(/actors\[1\]\.stats\.hp/);
    const rep = progress.find((p) => p.stage === 'repairing')!;
    expect(rep.errors).toBeGreaterThan(0);
    expect(rep.key).toBe('gen.progress.repairing');
    // the broken reply's title was already shown on the loading screen
    expect(progress.find((p) => p.stage === 'received')!.title).toBe('Lowmoor Goes Under');
  });

  it('reference errors (after zod passes) are repaired too', async () => {
    const w = structuredClone(raw('fixture-western'));
    w.areas[1].placedItems.push({ item: 'ghost-item', where: 'anywhere' });
    const mock = new MockProvider({ responses: { world: [{ json: w }, { json: raw('fixture-western') }] } });
    const res = await generateWorld({ provider: mock, balance: false });
    expect(res.attempts).toBe(2);
    expect(mock.calls[1]!.messages[2]!.content).toContain('unknown item "ghost-item"');
  });

  it('gives up after the repair budget with kind "invalid" and the last problems', async () => {
    const mock = new MockProvider({ responses: { world: { json: brokenTeen() } } });
    const err = await expectGenError(generateWorld({ provider: mock, balance: false, repairs: 1 }));
    expect(err.kind).toBe('invalid');
    expect(err.key).toBe('gen.error.invalid');
    expect(err.canPlayDemo).toBe(true);
    expect(err.attempts).toBe(2);
    expect(err.errors.some((e) => /hp/.test(e))).toBe(true);
    expect(mock.calls).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(err))).toMatchObject({ kind: 'invalid', canPlayDemo: true });
  });

  it('times out with kind "timeout"', async () => {
    const mock = new MockProvider({ responses: { world: { json: raw('fixture-teen') } }, latencyMs: 2000 });
    const t0 = Date.now();
    const err = await expectGenError(generateWorld({ provider: mock, balance: false, timeoutMs: 40 }));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('cancels with kind "aborted"', async () => {
    const mock = new MockProvider({ responses: { world: { json: raw('fixture-teen') } }, latencyMs: 2000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const err = await expectGenError(generateWorld({ provider: mock, balance: false, signal: ctrl.signal }));
    expect(err.kind).toBe('aborted');
  });

  it('maps provider errors to UI kinds', async () => {
    const failing = (e: Error): LLMProvider => ({ id: 'x', model: 'm', complete: async () => Promise.reject(e) });
    expect((await expectGenError(generateWorld({ provider: failing(new LLMAuthError('bad key')), balance: false }))).kind).toBe('auth');
    const rl = await expectGenError(generateWorld({ provider: failing(new LLMRateLimitError('slow down')), balance: false }));
    expect(rl.kind).toBe('rate_limit');
    expect(rl.retryable).toBe(true);
    expect((await expectGenError(generateWorld({ provider: failing(new Error('boom')), balance: false }))).kind).toBe('provider');
  });

  it('a world tuning cannot fix goes back to the model with balance feedback', async () => {
    const mock = new MockProvider({ responses: { world: [{ json: raw('fixture-dream') }, { json: raw('fixture-teen') }] } });
    const seen: string[] = [];
    const balancer: Balancer = (world) => {
      seen.push(world.meta.title);
      const bad = seen.length === 1;
      return {
        world,
        history: [],
        report: {
          world: world.meta.title,
          difficulty: 'normal',
          static: { areas: [], rules: [], issues: [], warnings: [] } as any,
          sims: [],
          verdict: bad ? 'unwinnable' : 'ok',
          reasons: bad ? ['goal: item "x" cannot be obtained'] : [],
          suggestions: bad ? ['place "x" with placedItems'] : [],
          winRate: bad ? 0 : 0.4,
          target: [0.25, 0.6],
        },
      };
    };
    const progress: GenerateProgress[] = [];
    const res = await generateWorld({ provider: mock, balancer, onProgress: (p) => progress.push(p), yieldToUi: async () => {} });
    expect(seen).toEqual(['The Fourth Primary', 'Lowmoor Goes Under']);
    expect(res.attempts).toBe(2);
    expect(res.world.meta.title).toBe('Lowmoor Goes Under');
    const fb = mock.calls[1]!.messages[2]!.content;
    expect(fb).toContain('UNWINNABLE');
    expect(fb).toContain('goal: item "x" cannot be obtained');
    expect(fb).toContain('place "x" with placedItems');
    expect(progress.map((p) => p.stage)).toContain('feedback');

    // without feedback rounds the same world is a typed "unbalanced" failure
    const mock2 = new MockProvider({ responses: { world: { json: raw('fixture-dream') } } });
    seen.length = 0;
    const err = await expectGenError(generateWorld({ provider: mock2, balancer, balanceFeedback: 0, yieldToUi: async () => {} }));
    expect(err.kind).toBe('unbalanced');
    expect(err.errors[0]).toContain('cannot be obtained');
  });

  it('a slow async balancer can be cancelled', async () => {
    const mock = new MockProvider({ responses: { world: { json: raw('fixture-teen') } } });
    const ctrl = new AbortController();
    const balancer: Balancer = (_w, _d, _o, signal) =>
      new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    setTimeout(() => ctrl.abort(), 30);
    const err = await expectGenError(generateWorld({ provider: mock, balancer, signal: ctrl.signal, yieldToUi: async () => {} }));
    expect(err.kind).toBe('aborted');
  });
});

describe('pipeline helpers', () => {
  it('checkWorldReply gives the repair message the model would get', async () => {
    const bad = await checkWorldReply(JSON.stringify(brokenTeen()));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.repair).toContain('Your previous reply could not be used.');
      expect(bad.repair).toContain('Output JSON only.');
    }
    const good = await checkWorldReply('```\n' + JSON.stringify(raw('fixture-ship')) + '\n```');
    expect(good.ok).toBe(true);
    expect((await checkWorldReply('no json here')).ok).toBe(false);
  });

  it('finaliseWorld sets language and prompt without touching the rest', () => {
    const w = parsed('fixture-teen');
    const f = finaliseWorld(w, { language: 'NB', prompt: ' hi ' });
    expect(f.meta.language).toBe('nb');
    expect(f.meta.prompt).toBe('hi');
    expect(f.actors).toBe(w.actors);
    const same = finaliseWorld(f, { language: 'nb', prompt: 'hi' });
    expect(same).toBe(f);
  });

  it('peekTitle reads titles from complete and cut-off replies', () => {
    expect(peekTitle(JSON.stringify({ meta: { title: 'A', tagline: 'B' } }))).toEqual({ title: 'A', tagline: 'B' });
    expect(peekTitle('{"specVersion":1,"meta":{"title":"Kåre \\"K\\" Ås","tagline":"cut')).toEqual({ title: 'Kåre "K" Ås' });
    expect(peekTitle('nothing')).toEqual({});
  });

  it('balanceFeedbackMessage', () => {
    const m = balanceFeedbackMessage({ verdict: 'broken', reasons: ['3/12 explorer runs soft-locked'], suggestions: [] });
    expect(m).toContain('BROKEN');
    expect(m).toContain('- 3/12 explorer runs soft-locked');
    expect(m).toContain('complete, corrected World Spec JSON');
  });

  it('a provider sees exactly one request per attempt', async () => {
    const reqs: CompletionRequest[] = [];
    const p: LLMProvider = {
      id: 'spy',
      model: 'spy-1',
      complete: async (r) => {
        reqs.push(r);
        return { text: JSON.stringify(raw('fixture-ship')), model: 'spy-1', usage: { inputTokens: 100, outputTokens: 2000 } };
      },
    };
    const res = await generateWorld({ provider: p, balance: false });
    expect(reqs).toHaveLength(1);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 2000 });
    expect(res.model).toBe('spy-1');
  });
});
