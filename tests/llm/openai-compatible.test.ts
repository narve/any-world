import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider, stripThinking } from '../../src/llm/openai-compatible';
import { LLMAuthError, LLMRateLimitError, LLMRefusalError, LLMInvalidResponseError, LLMServerError } from '../../src/llm/errors';
import { chatCompletion, fastRetry, json, mockFetch } from './helpers';

const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'go' }], purpose: 'gm:area_enter', jsonSchema: schema, schemaName: 'gm action!' };

function provider(f: ReturnType<typeof mockFetch>, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1/', model: 'm-1', apiKey: 'sk-test-abc', fetch: f, label: 'deepseek', ...fastRetry, ...extra });
}

describe('OpenAICompatibleProvider', () => {
  it('json_schema mode: sends response_format json_schema and no schema in the prompt', async () => {
    const f = mockFetch(json(chatCompletion('{"a":1}')));
    const r = await provider(f, { structuredOutput: 'json_schema' }).complete(req);
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
    expect(r.model).toBe('deepseek-chat');
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.example.com/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer sk-test-abc');
    expect(c.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'gm_action_', schema, strict: false } });
    expect(c.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(c.body.messages[1]).toEqual({ role: 'user', content: 'go' });
    expect(c.body.max_tokens).toBe(8192);
  });

  it('json_object mode: response_format json_object plus schema instruction in the system prompt', async () => {
    const f = mockFetch(json(chatCompletion('{"a":2}')));
    await provider(f, { structuredOutput: 'json_object' }).complete(req);
    const c = f.calls[0]!;
    expect(c.body.response_format).toEqual({ type: 'json_object' });
    expect(c.body.messages[0].content).toContain('Respond with a single valid JSON value only');
    expect(c.body.messages[0].content).toContain('"required":["a"]');
  });

  it('none mode: prompt-only, no response_format; temperature passed through', async () => {
    const f = mockFetch(json(chatCompletion('```json\n{"a":3}\n```')));
    await provider(f, { structuredOutput: 'none' }).complete({ ...req, temperature: 0.7 });
    const c = f.calls[0]!;
    expect(c.body.response_format).toBeUndefined();
    expect(c.body.temperature).toBe(0.7);
    expect(c.body.messages[0].content).toContain('JSON Schema');
  });

  it('omits the schema from the prompt when schemaInPrompt is false, and skips JSON mode when no schema', async () => {
    const f = mockFetch(json(chatCompletion('ok')));
    await provider(f, { structuredOutput: 'json_object' }).complete({ ...req, schemaInPrompt: false });
    expect(f.calls[0]!.body.messages[0].content).not.toContain('JSON Schema');
    await provider(f, { structuredOutput: 'json_schema' }).complete({ system: '', messages: req.messages, purpose: 'dialogue' });
    expect(f.calls[1]!.body.response_format).toBeUndefined();
    expect(f.calls[1]!.body.messages[0]).toEqual({ role: 'user', content: 'go' });
  });

  it('uses max_completion_tokens and drops temperature when the preset says so; no auth header without key', async () => {
    const f = mockFetch(json(chatCompletion('ok')));
    await provider(f, { apiKey: undefined, maxTokensParam: 'max_completion_tokens', supportsTemperature: false }).complete({ ...req, maxTokens: 99, temperature: 1 });
    const c = f.calls[0]!;
    expect(c.body.max_completion_tokens).toBe(99);
    expect(c.body.max_tokens).toBeUndefined();
    expect(c.body.temperature).toBeUndefined();
    expect(c.headers.authorization).toBeUndefined();
  });

  it('steps down json_schema -> json_object -> none when the endpoint rejects response_format', async () => {
    const reject = json({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported", type: 'invalid_request_error' } }, 400);
    const f = mockFetch(reject, reject, json(chatCompletion('{"a":4}')));
    const p = provider(f, { structuredOutput: 'json_schema' });
    const r = await p.complete(req);
    expect(r.text).toBe('{"a":4}');
    expect(f.calls.map((c) => c.body.response_format?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none']);
    expect(p.structuredMode).toBe('none');
  });

  it('strips <think> blocks and joins content parts', async () => {
    expect(stripThinking('<think>hmm\n</think>\n{"a":1}')).toBe('{"a":1}');
    const f = mockFetch(json(chatCompletion('', { choices: [{ message: { content: [{ type: 'text', text: '{"a"' }, { type: 'text', text: ':5}' }] }, finish_reason: 'stop' }] })));
    expect((await provider(f).complete(req)).text).toBe('{"a":5}');
  });

  it('maps finish_reason length to stopReason max_tokens', async () => {
    const f = mockFetch(json(chatCompletion('{"a":', { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] })));
    expect((await provider(f).complete(req)).stopReason).toBe('max_tokens');
  });

  it('maps errors: 401 auth, 429 rate limit (retry-after-ms), 503 server, content filter, empty body', async () => {
    const a = await provider(mockFetch(json({ error: { message: 'Incorrect API key provided: sk-test-abc', code: 'invalid_api_key' } }, 401))).complete(req).catch((e) => e);
    expect(a).toBeInstanceOf(LLMAuthError);
    expect(a.message).not.toContain('sk-test-abc');
    expect(a.message).toContain('[redacted]');

    const rl = mockFetch(json({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after-ms': '90000' }));
    const b = await provider(rl).complete(req).catch((e) => e);
    expect(b).toBeInstanceOf(LLMRateLimitError);
    expect(b.retryAfterMs).toBe(90_000);

    const s = mockFetch(json({ error: { message: 'busy' } }, 503));
    const c = await provider(s, { maxRetries: 1 }).complete(req).catch((e) => e);
    expect(c).toBeInstanceOf(LLMServerError);
    expect(s.calls).toHaveLength(2);

    const cf = mockFetch(json(chatCompletion('', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })));
    expect(await provider(cf).complete(req).catch((e) => e)).toBeInstanceOf(LLMRefusalError);

    const empty = mockFetch(json({ choices: [] }));
    expect(await provider(empty).complete(req).catch((e) => e)).toBeInstanceOf(LLMInvalidResponseError);
  });
});
