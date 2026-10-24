import { describe, it, expect } from 'vitest';
import { createProvider, BackendProvider, fetchServerPresets } from '../../src/llm/transport';
import { AnthropicProvider } from '../../src/llm/anthropic';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible';
import { MockProvider } from '../../src/llm/mock';
import { PRESETS, getPreset } from '../../src/llm/presets';
import { LLMConfigError, LLMRateLimitError, LLMRefusalError } from '../../src/llm/errors';
import { isRecursiveSchema, sanitizeSchemaForAnthropic, jsonInstruction } from '../../src/llm/json-schema';
import { anthropicMessage, chatCompletion, json, mockFetch } from './helpers';

const req = { system: 's', messages: [{ role: 'user' as const, content: 'q' }], purpose: 'dialogue' };

describe('presets', () => {
  it('cover the required providers with sane values', () => {
    const ids = PRESETS.map((p) => p.id);
    for (const id of ['anthropic', 'openai', 'deepseek', 'mistral', 'qwen', 'moonshot', 'zhipu', 'openrouter', 'ollama', 'lmstudio', 'custom']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESETS) {
      if (p.id !== 'custom') {
        expect(p.baseUrl).toMatch(/^https?:\/\//);
        expect(p.defaultModel).not.toBe('');
      }
      if (p.needsKey) expect(p.envKey).toMatch(/^[A-Z_]+_API_KEY$/);
      expect(p.contextTokens).toBeGreaterThan(0);
    }
    expect(getPreset('anthropic')!.kind).toBe('anthropic');
    expect(getPreset('qwen')!.baseUrl).toContain('dashscope-intl');
    expect(getPreset('ollama')!.notes).toContain('OLLAMA_ORIGINS');
    expect(getPreset('deepseek')!.region).toBe('China');
    expect(getPreset('mistral')!.region).toBe('EU');
  });
});

describe('createProvider', () => {
  it('direct: builds Anthropic and OpenAI-compatible providers from presets', async () => {
    const f = mockFetch(json(anthropicMessage('hi')));
    const a = createProvider({ preset: 'anthropic', apiKey: 'k-anth', transport: 'direct' }, { fetch: f, browser: true });
    expect(a).toBeInstanceOf(AnthropicProvider);
    expect(a.model).toBe('claude-opus-5-5');
    await a.complete(req);
    expect(f.calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    const g = mockFetch(json(chatCompletion('{"a":1}')));
    const d = createProvider({ preset: 'deepseek', apiKey: 'k-ds', model: 'deepseek-reasoner', transport: 'direct' }, { fetch: g });
    expect(d).toBeInstanceOf(OpenAICompatibleProvider);
    await d.complete({ ...req, jsonSchema: { type: 'object' } });
    expect(g.calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(g.calls[0]!.body.model).toBe('deepseek-reasoner');
    expect(g.calls[0]!.body.response_format).toEqual({ type: 'json_object' });

    const o = createProvider({ preset: 'ollama', transport: 'direct' });
    expect(o.model).toBe(getPreset('ollama')!.defaultModel);
    const c = createProvider({ preset: 'custom', baseUrl: 'http://my.llm/v1', model: 'm', transport: 'direct' });
    expect(c.model).toBe('m');
  });

  it('direct: rejects missing keys, unknown presets and incomplete custom config', () => {
    expect(() => createProvider({ preset: 'anthropic', transport: 'direct' })).toThrow(LLMConfigError);
    expect(() => createProvider({ preset: 'nope', transport: 'direct' })).toThrow(LLMConfigError);
    expect(() => createProvider({ preset: 'custom', transport: 'direct' })).toThrow(/base URL/);
    expect(() => createProvider({ preset: 'custom', baseUrl: 'http://x', transport: 'direct' })).toThrow(/model/);
  });

  it('mock preset works in either transport', async () => {
    const m = createProvider({ preset: 'mock', transport: 'backend' }, { mock: { responses: { dialogue: 'canned' } } });
    expect(m).toBeInstanceOf(MockProvider);
    expect((await m.complete(req)).text).toBe('canned');
  });

  it('backend: POSTs {preset, model, request} and never sends a key', async () => {
    const f = mockFetch(json({ response: { text: 'from server', model: 'deepseek-chat', usage: { inputTokens: 1, outputTokens: 2 } } }));
    const p = createProvider({ preset: 'deepseek', apiKey: 'should-not-be-sent', transport: 'backend' }, { fetch: f, backendUrl: 'http://srv:8787/' });
    expect(p).toBeInstanceOf(BackendProvider);
    const r = await p.complete({ ...req, signal: new AbortController().signal });
    expect(r).toEqual({ text: 'from server', model: 'deepseek-chat', stopReason: undefined, usage: { inputTokens: 1, outputTokens: 2 } });
    const c = f.calls[0]!;
    expect(c.url).toBe('http://srv:8787/api/llm');
    expect(c.body).toEqual({ preset: 'deepseek', request: req });
    expect(JSON.stringify(c)).not.toContain('should-not-be-sent');
    const withModel = createProvider({ preset: 'anthropic', model: 'claude-sonnet-5-5', transport: 'backend' }, { fetch: f, backendUrl: 'http://srv' });
    await withModel.complete(req);
    expect(f.calls[1]!.body.model).toBe('claude-sonnet-5-5');
  });

  it('backend: re-types server errors', async () => {
    const f = mockFetch(
      json({ error: { kind: 'rate_limit', type: 'rate_limit', message: 'upstream busy' } }, 429, { 'retry-after': '4' }),
      json({ error: { kind: 'refusal', type: 'refusal', message: 'declined' } }, 422),
    );
    const p = new BackendProvider('anthropic', undefined, { fetch: f, backendUrl: 'http://srv' });
    const e1 = await p.complete(req).catch((e) => e);
    expect(e1).toBeInstanceOf(LLMRateLimitError);
    expect(e1.retryAfterMs).toBe(4000);
    expect(e1.message).toBe('upstream busy');
    expect(await p.complete(req).catch((e) => e)).toBeInstanceOf(LLMRefusalError);
  });

  it('fetchServerPresets reads /api/presets', async () => {
    const f = mockFetch(json({ presets: [{ id: 'anthropic', configured: true }] }));
    const list = await fetchServerPresets('http://srv/', { fetch: f });
    expect(list[0]!.id).toBe('anthropic');
  });
});

describe('json-schema helpers', () => {
  it('detects recursion', () => {
    expect(isRecursiveSchema({ type: 'object' })).toBe(false);
    expect(isRecursiveSchema({ $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'string' } }, $ref: '#/$defs/a' })).toBe(false);
    expect(isRecursiveSchema({ $defs: { a: { items: { $ref: '#/$defs/b' } }, b: { items: { $ref: '#/$defs/a' } } } })).toBe(true);
    expect(isRecursiveSchema({ type: 'object', properties: { kid: { $ref: '#' } } })).toBe(true);
  });

  it('sanitises without touching property names or enum values', () => {
    const s = sanitizeSchemaForAnthropic({
      $schema: 'x',
      type: 'object',
      properties: { minimum: { type: 'number', maximum: 3 }, list: { type: 'array', minItems: 2, items: { type: 'string', enum: ['default'] } } },
      additionalProperties: true,
    }) as any;
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.minimum).toEqual({ type: 'number' });
    expect(s.properties.list.minItems).toBeUndefined();
    expect(s.properties.list.items.enum).toEqual(['default']);
  });

  it('omits huge schemas from prompts unless forced', () => {
    const big = { type: 'object', description: 'x'.repeat(30_000) };
    expect(jsonInstruction(big)).not.toContain('JSON Schema');
    expect(jsonInstruction(big, true)).toContain('JSON Schema');
    expect(jsonInstruction({ type: 'object' }, false)).not.toContain('JSON Schema');
  });
});
