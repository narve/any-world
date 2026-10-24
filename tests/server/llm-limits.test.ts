import { describe, it, expect, vi, afterEach } from 'vitest';
import { startServer } from '../../server/index';
import { upstreamOptions } from '../../server/app';
import { MockProvider } from '../../src/llm/mock';
import { DEFAULT_TIMEOUT_MS } from '../../src/llm/http';
import type { FetchLike } from '../../src/llm/http';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
});

async function post(base: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const llmBody = (preset: string, content = 'hi') => ({
  preset,
  request: { system: 'sys', messages: [{ role: 'user', content }], purpose: 'dialogue' },
});

describe('server upstream timeouts (M1 issue: 120 s cap, then retried twice)', () => {
  it('reads LLM_TIMEOUT_MS / LLM_TOTAL_TIMEOUT_MS / LLM_MAX_RETRIES with sane defaults', () => {
    expect(upstreamOptions({})).toEqual({ timeoutMs: DEFAULT_TIMEOUT_MS, totalTimeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: 2, retryOnTimeout: false });
    expect(upstreamOptions({ LLM_TIMEOUT_MS: '900000', LLM_MAX_RETRIES: '0' })).toMatchObject({ timeoutMs: 900_000, totalTimeoutMs: 900_000, maxRetries: 0 });
    expect(upstreamOptions({ LLM_TIMEOUT_MS: '1000', LLM_TOTAL_TIMEOUT_MS: '5000' })).toMatchObject({ timeoutMs: 1000, totalTimeoutMs: 5000 });
    expect(upstreamOptions({ LLM_TIMEOUT_MS: 'soon', LLM_MAX_RETRIES: '-1' })).toMatchObject({ timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: 2 });
    expect(upstreamOptions({ LLM_TIMEOUT_MS: '1000' }, { timeoutMs: 5 })).toMatchObject({ timeoutMs: 5 });
  });

  it('answers 504 after one upstream attempt when the provider never responds', async () => {
    let calls = 0;
    const hang: FetchLike = (_u, init) => {
      calls++;
      return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    };
    const s = await startServer({
      port: 0,
      host: '127.0.0.1',
      env: { ANTHROPIC_API_KEY: 'sk-test-123456', LLM_TIMEOUT_MS: '40' },
      fetch: hang,
      log: () => {},
    });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    const r = await post(base, llmBody('anthropic'));
    expect(r.status).toBe(504);
    expect(r.json.error.kind).toBe('timeout');
    expect(calls).toBe(1);
    const presets = await (await fetch(`${base}/api/presets`)).json();
    expect(presets.upstreamTimeoutMs).toBe(40);
  });
});

describe('server mock preset memory (M1 issue: every request body kept forever)', () => {
  it('does not retain request bodies across requests', async () => {
    const spy = vi.spyOn(MockProvider.prototype, 'complete');
    const s = await startServer({ port: 0, host: '127.0.0.1', env: {}, recordings: [{ purpose: 'dialogue', text: 'line' }], log: () => {} });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    for (let i = 0; i < 5; i++) {
      const r = await post(base, llmBody('mock', 'x'.repeat(10_000)));
      expect(r.status).toBe(200);
    }
    const instance = spy.mock.contexts[0] as MockProvider;
    expect(spy.mock.contexts.every((c) => c === instance)).toBe(true);
    expect(instance.callCount).toBe(5);
    expect(instance.calls).toHaveLength(0);
  });
});

describe('server model allowlist (M1 issue: openrouter accepted any model on the owner key)', () => {
  const orFetch = (): { fetch: FetchLike; models: string[] } => {
    const models: string[] = [];
    const fetch: FetchLike = async (_u, init) => {
      const b = JSON.parse(String(init?.body ?? '{}'));
      models.push(b.model);
      return new Response(
        JSON.stringify({ id: 'x', model: b.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { fetch, models };
  };
  const start = async (env: Record<string, string>, fetch: FetchLike) => {
    const s = await startServer({ port: 0, host: '127.0.0.1', env, fetch, log: () => {} });
    closers.push(s.close);
    return `http://127.0.0.1:${s.port}`;
  };
  const withModel = (preset: string, model?: string) => ({ ...llmBody(preset), ...(model ? { model } : {}) });

  it('refuses a non-default openrouter model with 400 and never calls upstream', async () => {
    const up = orFetch();
    const base = await start({ OPENROUTER_API_KEY: 'sk-or-test-1234' }, up.fetch);
    const bad = await post(base, { ...withModel('openrouter', 'openai/o1-pro'), request: { ...llmBody('openrouter').request, maxTokens: 32000 } });
    expect(bad.status).toBe(400);
    expect(up.models).toEqual([]);
    const ok = await post(base, withModel('openrouter'));
    expect(ok.status).toBe(200);
    expect(up.models).toEqual(['deepseek/deepseek-chat-v3.1']);
    const info = await (await fetch(`${base}/api/presets`)).json();
    const or = info.presets.find((p: any) => p.id === 'openrouter');
    expect(or.models).toEqual(['deepseek/deepseek-chat-v3.1']);
    expect(or.modelsRestricted).toBe(true);
  });

  it('allows models from OPENROUTER_MODELS and OPENROUTER_MODEL, or anything with LLM_ALLOW_ANY_MODEL=1', async () => {
    const up = orFetch();
    const base = await start({ OPENROUTER_API_KEY: 'sk-or-test-1234', OPENROUTER_MODEL: 'a/default', OPENROUTER_MODELS: 'b/one, c/two' }, up.fetch);
    expect((await post(base, withModel('openrouter', 'c/two'))).status).toBe(200);
    expect((await post(base, withModel('openrouter', 'a/default'))).status).toBe(200);
    expect((await post(base, withModel('openrouter', 'deepseek/deepseek-chat-v3.1'))).status).toBe(400);
    expect(up.models).toEqual(['c/two', 'a/default']);

    const up2 = orFetch();
    const base2 = await start({ OPENROUTER_API_KEY: 'sk-or-test-1234', LLM_ALLOW_ANY_MODEL: '1' }, up2.fetch);
    expect((await post(base2, withModel('openrouter', 'openai/o1-pro'))).status).toBe(200);
  });

  it('keeps keyless local presets with an operator-set base URL open', async () => {
    const up = orFetch();
    const base = await start({ OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1' }, up.fetch);
    expect((await post(base, withModel('ollama', 'qwen3:8b'))).status).toBe(200);
    expect(up.models).toEqual(['qwen3:8b']);
  });

  it('still refuses unlisted models for keyed presets with a model list', async () => {
    const up = orFetch();
    const base = await start({ DEEPSEEK_API_KEY: 'sk-ds-test-1234' }, up.fetch);
    expect((await post(base, withModel('deepseek', 'deepseek-reasoner'))).status).toBe(200);
    expect((await post(base, withModel('deepseek', 'gpt-5'))).status).toBe(400);
  });
});

describe('server model allowlist for a keyed custom preset (M1 issue: custom + CUSTOM_LLM_API_KEY was open)', () => {
  const capture = () => {
    const seen: { model: string; auth: string }[] = [];
    const fetch: FetchLike = async (_u, init) => {
      const b = JSON.parse(String(init?.body ?? '{}'));
      const h = new Headers(init?.headers as HeadersInit);
      seen.push({ model: b.model, auth: h.get('authorization') ?? '' });
      return new Response(
        JSON.stringify({ id: 'x', model: b.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { fetch, seen };
  };
  const keyedCustom = { CUSTOM_LLM_BASE_URL: 'https://api.together.example/v1', CUSTOM_LLM_API_KEY: 'sk-owner-paid-key', CUSTOM_LLM_MODEL: 'cheap-8b' };

  it('refuses a non-default model on the owner key and reports the preset as restricted', async () => {
    const up = capture();
    const s = await startServer({ port: 0, host: '127.0.0.1', env: keyedCustom, fetch: up.fetch, log: () => {} });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    const bad = await post(base, { ...llmBody('custom'), model: 'meta-llama/Llama-3.1-405B-Instruct-Turbo' });
    expect(bad.status).toBe(400);
    expect(up.seen).toEqual([]);
    const ok = await post(base, llmBody('custom'));
    expect(ok.status).toBe(200);
    expect(up.seen).toEqual([{ model: 'cheap-8b', auth: 'Bearer sk-owner-paid-key' }]);
    const info = await (await fetch(`${base}/api/presets`)).json();
    const c = info.presets.find((p: any) => p.id === 'custom');
    expect(c.modelsRestricted).toBe(true);
    expect(c.models).toEqual(['cheap-8b']);
  });

  it('CUSTOM_MODELS extends the keyed custom allowlist; a keyless custom preset stays open', async () => {
    const up = capture();
    const s = await startServer({ port: 0, host: '127.0.0.1', env: { ...keyedCustom, CUSTOM_MODELS: 'mid-70b' }, fetch: up.fetch, log: () => {} });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    expect((await post(base, { ...llmBody('custom'), model: 'mid-70b' })).status).toBe(200);
    expect((await post(base, { ...llmBody('custom'), model: 'huge-405b' })).status).toBe(400);

    const up2 = capture();
    const s2 = await startServer({ port: 0, host: '127.0.0.1', env: { CUSTOM_LLM_BASE_URL: 'http://127.0.0.1:9/v1', CUSTOM_LLM_MODEL: 'local' }, fetch: up2.fetch, log: () => {} });
    closers.push(s2.close);
    expect((await post(`http://127.0.0.1:${s2.port}`, { ...llmBody('custom'), model: 'anything' })).status).toBe(200);
  });

  it('caps the provider cache for open presets (LRU)', async () => {
    const up = capture();
    const s = await startServer({ port: 0, host: '127.0.0.1', env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1' }, fetch: up.fetch, log: () => {}, maxCachedProviders: 3 });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    for (let i = 0; i < 10; i++) expect((await post(base, { ...llmBody('ollama'), model: `m${i}` })).status).toBe(200);
    expect(s.cachedProviderCount()).toBe(3);
    expect(up.seen.map((x) => x.model)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  });
});

describe('server shared provider state (M1 issue: one bad schema downgraded every user)', () => {
  it("a client's rejected schema does not stop the next client's request from using output_config.format", async () => {
    const bodies: any[] = [];
    const upstream: FetchLike = async (_u, init) => {
      const b = JSON.parse(String(init?.body));
      bodies.push(b);
      if (b.output_config?.format?.schema?.properties?.evil) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: Schema is too complex for grammar compilation' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"a":"x"}' }], stop_reason: 'end_turn', model: 'claude-opus-5-5' }), { status: 200 });
    };
    const s = await startServer({ port: 0, host: '127.0.0.1', env: { ANTHROPIC_API_KEY: 'sk-test-123456' }, fetch: upstream, log: () => {} });
    closers.push(s.close);
    const base = `http://127.0.0.1:${s.port}`;
    const withSchema = (props: Record<string, unknown>) => ({
      preset: 'anthropic',
      request: { system: 'sys', messages: [{ role: 'user', content: 'hi' }], purpose: 'p', jsonSchema: { type: 'object', properties: props, required: Object.keys(props) } },
    });
    expect((await post(base, withSchema({ evil: { type: 'string' } }))).status).toBe(200); // prompt-only for that call
    expect(bodies.map((b) => !!b.output_config?.format)).toEqual([true, false]);
    expect((await post(base, withSchema({ a: { type: 'string' } }))).status).toBe(200);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].output_config?.format?.type).toBe('json_schema');
    expect(bodies[2].system).toBe('sys');
  });
});
