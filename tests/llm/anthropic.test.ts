import { describe, it, expect } from 'vitest';
import { AnthropicProvider, ANTHROPIC_API_VERSION } from '../../src/llm/anthropic';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMServerError,
  LLMRefusalError,
  LLMInvalidResponseError,
  LLMBadRequestError,
} from '../../src/llm/errors';
import { anthropicMessage, fastRetry, json, mockFetch } from './helpers';

const schema = {
  type: 'object',
  properties: { name: { type: 'string', minLength: 2 }, hp: { type: 'integer', minimum: 1 } },
  required: ['name', 'hp'],
};

const req = { system: 'You invent worlds.', messages: [{ role: 'user' as const, content: 'Hi' }], purpose: 'world' };

describe('AnthropicProvider', () => {
  it('sends a Messages API request with the right headers and parses text + usage', async () => {
    const f = mockFetch(json(anthropicMessage('Hello there')));
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test-123', fetch: f, browser: false });
    const r = await p.complete({ ...req, temperature: 0.4, maxTokens: 500 });
    expect(r.text).toBe('Hello there');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.stopReason).toBe('end_turn');
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test-123');
    expect(call.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(call.body.model).toBe('claude-opus-5-5');
    expect(call.body.max_tokens).toBe(500);
    expect(call.body.system).toBe('You invent worlds.');
    expect(call.body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(call.body.temperature).toBeUndefined(); // rejected by API version 2026-10-21
    // server-side refusal fallback for supported models at the official endpoint
    expect(call.body.fallbacks).toBe('default');
    expect(call.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('adds the direct-browser-access header in browser mode', async () => {
    const f = mockFetch(json(anthropicMessage('ok')));
    await new AnthropicProvider({ apiKey: 'k-browser', fetch: f, browser: true }).complete(req);
    expect(f.calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('uses native structured output with a sanitised schema (json_schema mode)', async () => {
    const f = mockFetch(json(anthropicMessage('{"name":"Ada","hp":3}')));
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, effort: 'high' });
    const r = await p.complete({ ...req, jsonSchema: schema, schemaName: 'thing' });
    expect(JSON.parse(r.text)).toEqual({ name: 'Ada', hp: 3 });
    const body = f.calls[0]!.body;
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    const sent = body.output_config.format.schema;
    expect(sent.additionalProperties).toBe(false);
    expect(sent.properties.name.minLength).toBeUndefined();
    expect(sent.properties.hp.minimum).toBeUndefined();
    expect(sent.required).toEqual(['name', 'hp']);
    expect(body.system).toBe('You invent worlds.'); // no prompt-side schema needed
  });

  it('falls back to prompt-only JSON for recursive schemas', async () => {
    const f = mockFetch(json(anthropicMessage('{}')));
    const recursive = { $ref: '#/$defs/node', $defs: { node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/node' } } } } } };
    await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false }).complete({ ...req, jsonSchema: recursive });
    const body = f.calls[0]!.body;
    expect(body.output_config).toBeUndefined();
    expect(body.system).toContain('Respond with a single valid JSON value only');
    expect(body.system).toContain('"$defs"');
  });

  it('drops output_config.format and retries when the upstream rejects this schema (this call only)', async () => {
    const f = mockFetch(
      json({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format: schema too complex' } }, 400),
      json(anthropicMessage('{"name":"Bo","hp":1}')),
    );
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, refusalFallback: false });
    const r = await p.complete({ ...req, jsonSchema: schema });
    expect(r.text).toContain('Bo');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body.output_config).toBeUndefined();
    expect(f.calls[1]!.body.system).toContain('JSON Schema');
    // an error about this request's schema is not remembered: the provider may be shared by many players
    await p.complete({ ...req, jsonSchema: schema });
    expect(f.calls[2]!.body.output_config?.format?.type).toBe('json_schema');
  });

  it('does not request fallbacks for custom base URLs or unsupported models', async () => {
    const f = mockFetch(json(anthropicMessage('ok')));
    await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, model: 'claude-haiku-5-5' }).complete(req);
    await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, baseUrl: 'http://proxy.local/' }).complete(req);
    expect(f.calls[0]!.body.fallbacks).toBeUndefined();
    expect(f.calls[1]!.body.fallbacks).toBeUndefined();
    expect(f.calls[1]!.url).toBe('http://proxy.local/v1/messages');
  });

  it('maps 401 to LLMAuthError without leaking the key', async () => {
    const f = mockFetch(json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret-999' } }, 401));
    const p = new AnthropicProvider({ apiKey: 'sk-ant-secret-999', fetch: f, browser: false });
    const err = await p.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('authentication_error');
    expect(err.message).not.toContain('sk-ant-secret-999');
    expect(err.retryable).toBe(false);
  });

  it('maps 429 to LLMRateLimitError with retry-after and retries it', async () => {
    const limited = json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '0' });
    const f = mockFetch(limited, json(anthropicMessage('after wait')));
    const r = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, ...fastRetry }).complete(req);
    expect(r.text).toBe('after wait');
    expect(f.calls).toHaveLength(2);

    const f2 = mockFetch(json({ error: { type: 'rate_limit_error', message: 'slow' } }, 429, { 'retry-after': '120' }));
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: f2, browser: false, ...fastRetry }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect(err.retryAfterMs).toBe(120_000);
    expect(f2.calls).toHaveLength(1); // retry-after beyond our cap: surfaced, not slept on
  });

  it('maps 529 overloaded to LLMServerError after exhausting retries', async () => {
    const f = mockFetch(json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529));
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, maxRetries: 2, ...fastRetry }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMServerError);
    expect(err.code).toBe('overloaded_error');
    expect(f.calls).toHaveLength(3);
  });

  it('throws LLMRefusalError on stop_reason refusal', async () => {
    const f = mockFetch(json(anthropicMessage('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' } })));
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMRefusalError);
    expect(err.message).toContain('cyber');
  });

  it('rejects malformed bodies as LLMInvalidResponseError', async () => {
    const f = mockFetch(new Response('<html>gateway</html>', { status: 200 }));
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMInvalidResponseError);
    const f2 = mockFetch(json({ hello: 1 }));
    expect(await new AnthropicProvider({ apiKey: 'k1234', fetch: f2, browser: false }).complete(req).catch((e) => e)).toBeInstanceOf(LLMInvalidResponseError);
  });

  it('returns truncated output with stopReason max_tokens', async () => {
    const f = mockFetch(json(anthropicMessage('{"name": "A', { stop_reason: 'max_tokens' })));
    const r = await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false }).complete(req);
    expect(r.stopReason).toBe('max_tokens');
  });

  it('maps other 4xx to LLMBadRequestError', async () => {
    const f = mockFetch(json({ type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }, 404));
    expect(await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false }).complete(req).catch((e) => e)).toBeInstanceOf(LLMBadRequestError);
  });
});
