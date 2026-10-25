/**
 * M5 review round 3 (balance & robustness): more hostile replies through generateWorld with the
 * mock provider. The pipeline must return a world or throw a typed WorldGenerationError — never a
 * RangeError/TypeError — whatever the model sends.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MockProvider } from '../../../src/llm/mock';
import { generateWorld, WorldGenerationError } from '../../../src/llm/generate';

const fixture = () => JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8')) as Record<string, any>;

async function outcome(texts: string[], balance: false | { seeds: number; rounds: number; confirm: boolean } = false) {
  const mock = new MockProvider({ responses: { world: texts.map((text) => ({ text })) as never } });
  try {
    const res = await generateWorld({ provider: mock, prompt: 'x', balance, repairs: texts.length - 1, balanceFeedback: 0, yieldToUi: async () => {}, timeoutMs: 60_000 });
    return { ok: true as const, res, calls: mock.calls.length, thrown: null as string | null };
  } catch (e) {
    const typed = e instanceof WorldGenerationError;
    return { ok: false as const, calls: mock.calls.length, thrown: typed ? null : `${(e as Error).name}: ${(e as Error).message}`, kind: typed ? e.kind : undefined };
  }
}

/** a reply whose goal.win nests `n` `not` conditions (about 23 bytes per level) */
function deepGoalReply(n: number): string {
  const w = fixture();
  w.goal.win = '@@DEEP@@';
  const deep = '{"type":"not","cond":'.repeat(n) + '{"type":"always"}' + '}'.repeat(n);
  return JSON.stringify(w).replace('"@@DEEP@@"', `{"type":"any","of":[{"type":"flag","flag":"speech-delivered"},${deep}]}`);
}

describe('deeply nested conditions in a generated world', () => {
  for (const n of [3000, 10_000]) {
    it(`goal.win with ${n} nested 'not' (${Math.round(deepGoalReply(n).length / 1024)} kB) fails typed, no RangeError`, async () => {
      const text = deepGoalReply(n);
      const r = await outcome([text, text]);
      expect(r.thrown).toBeNull();
    });
  }
  it('the same nesting inside a rule condition fails typed, no RangeError', async () => {
    const w = fixture();
    const deep = '{"type":"not","cond":'.repeat(3000) + '{"type":"always"}' + '}'.repeat(3000);
    w.rules[0].when = '@@DEEP@@';
    const text = JSON.stringify(w).replace('"@@DEEP@@"', deep);
    const r = await outcome([text, text]);
    expect(r.thrown).toBeNull();
  });
});

describe('nesting that still validates', () => {
  it('goal.win with 1000 nested `not` validates and survives the balance sims', async () => {
    const text = deepGoalReply(1000);
    const r = await outcome([text], { seeds: 2, rounds: 0, confirm: false });
    expect(r.thrown).toBeNull();
  }, 120_000);
});
