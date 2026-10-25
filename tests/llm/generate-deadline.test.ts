/**
 * Regression test for review M5 round 2 (issues/M5-generation-deadline.md): world generation's
 * default total deadline was 300 s for all provider calls together, below what a single
 * legitimate reply may take (600 s per attempt, 660 s through the backend).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/types';
import { LLMAbortedError } from '../../src/llm/errors';
import { DEFAULT_TIMEOUT_MS, DEFAULT_BACKEND_TIMEOUT_MS } from '../../src/llm/http';
import { generateWorld, GENERATION_CALL_BUDGET_MS, WorldGenerationError } from '../../src/llm/generate';
import { WorldGeneration } from '../../src/client/ai';

const worldText = readFileSync('content/worlds/fixture-teen.json', 'utf8');

/** a provider that answers with `texts[i]` after `ms[i]` (honours the abort signal) */
function slow(ms: number[], texts: string[] = [worldText]): LLMProvider {
  let i = 0;
  return {
    id: 'slow',
    model: 'slow',
    complete(req: CompletionRequest): Promise<CompletionResponse> {
      const n = i++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: texts[Math.min(n, texts.length - 1)]!, model: 'slow', stopReason: 'end' } as CompletionResponse), ms[Math.min(n, ms.length - 1)]);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new LLMAbortedError());
        });
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('world generation deadline', () => {
  it('each call gets at least the longest transport budget', () => {
    expect(GENERATION_CALL_BUDGET_MS).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_MS);
    expect(GENERATION_CALL_BUDGET_MS).toBe(DEFAULT_BACKEND_TIMEOUT_MS);
  });

  it('the client WorldGeneration (built as main.ts builds it) survives a 6 minute reply', async () => {
    vi.useFakeTimers();
    const gen = new WorldGeneration(slow([360_000]), { prompt: 'a teen drama', surprise: false, difficulty: 'normal', weirdness: 0.5, language: 'en' }, { balance: false });
    const p = gen.run().then(
      (w) => ({ ok: true as const, title: w.meta.title }),
      (e: { kind?: string }) => ({ ok: false as const, kind: e.kind }),
    );
    await vi.advanceTimersByTimeAsync(361_000);
    expect(await p).toEqual({ ok: true, title: expect.any(String) });
  });

  it('a repair turn after a slow first reply is not cut off', async () => {
    vi.useFakeTimers();
    const p = generateWorld({ provider: slow([300_000, 300_000], ['{"not":"a world"}', worldText]), balance: false }).then(
      (r) => ({ ok: true as const, attempts: r.attempts }),
      (e: WorldGenerationError) => ({ ok: false as const, kind: e.kind }),
    );
    await vi.advanceTimersByTimeAsync(601_000);
    expect(await p).toEqual({ ok: true, attempts: 2 });
  });

  it('an explicit timeoutMs still ends the pipeline with kind "timeout"', async () => {
    vi.useFakeTimers();
    const p = generateWorld({ provider: slow([10_000]), balance: false, timeoutMs: 5_000 }).catch((e: WorldGenerationError) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(((await p) as WorldGenerationError).kind).toBe('timeout');
  });
});
