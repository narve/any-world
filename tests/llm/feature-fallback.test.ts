/**
 * M1 issue: one request could turn off native structured output (or fallbacks / effort) for every
 * user of the server, because the provider instance and its disabled-feature state are shared.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, anthropicFeatureRejectedByEndpoint } from '../../src/llm/anthropic';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible';
import { isEndpointFeatureRejection } from '../../src/llm/errors';
import type { CompletionRequest } from '../../src/llm/types';
import { anthropicMessage, chatCompletion, fastRetry, json, mockFetch, type FetchCall } from './helpers';

const simple: CompletionRequest = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  purpose: 'test',
  jsonSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
};
const complex: CompletionRequest = {
  ...simple,
  jsonSchema: { type: 'object', properties: { evil: { type: 'string' } }, required: ['evil'] },
};
const anthropicErr = (message: string) => json({ type: 'error', error: { type: 'invalid_request_error', message } }, 400);
const openaiErr = (message: string) => json({ error: { message, type: 'invalid_request_error' } }, 400);

describe('isEndpointFeatureRejection', () => {
  it('endpoint-level: the parameter itself is not accepted', () => {
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: output_config: Extra inputs are not permitted')).toBe(true);
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: output_config.format: Extra inputs are not permitted')).toBe(true);
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: structured outputs are not supported for this model')).toBe(true);
    expect(anthropicFeatureRejectedByEndpoint('fallbacks', 'anthropic HTTP 400: anthropic-beta: unknown beta header')).toBe(true);
    expect(anthropicFeatureRejectedByEndpoint('effort', "anthropic HTTP 400: output_config.effort: Input should be 'low', 'medium' or 'high'")).toBe(true);
    expect(isEndpointFeatureRejection("Invalid parameter: 'response_format' of type 'json_schema' is not supported", ['response_format', 'json_schema'])).toBe(true);
  });

  it('request-level: about this request schema', () => {
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: output_config.format.schema: Schema is too complex for grammar compilation')).toBe(false);
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: output_config.format.schema: keyword "patternProperties" is not supported')).toBe(false);
    expect(anthropicFeatureRejectedByEndpoint('format', 'anthropic HTTP 400: output_config.format: invalid value')).toBe(false);
    expect(anthropicFeatureRejectedByEndpoint('fallbacks', 'anthropic HTTP 400: output_config.format.schema.properties.beta: bad')).toBe(false);
    expect(isEndpointFeatureRejection("Invalid schema for response_format 'world': 'additionalProperties' is required", ['response_format', 'json_schema'])).toBe(false);
  });
});

describe('AnthropicProvider: per-request feature fallback', () => {
  const formatOf = (c: FetchCall) => !!c.body.output_config?.format;

  it('a schema the upstream rejects drops the format for that call only', async () => {
    const f = mockFetch((c) =>
      c.body.output_config?.format?.schema?.properties?.evil
        ? anthropicErr('output_config.format.schema: Schema is too complex for grammar compilation')
        : json(anthropicMessage('{"a":"x"}')),
    );
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, ...fastRetry });
    expect((await p.complete(complex)).text).toBe('{"a":"x"}');
    expect(f.calls.map(formatOf)).toEqual([true, false]);
    expect(f.calls[1]!.body.system).toContain('JSON');
    expect(p.disabledFeatures).toEqual([]);
    await p.complete(simple);
    expect(formatOf(f.calls[2]!)).toBe(true);
    expect(f.calls[2]!.body.system).toBe('sys');
    // the bad schema keeps getting the per-call fallback (no state leaks either way)
    await p.complete(complex);
    expect(f.calls.slice(3).map(formatOf)).toEqual([true, false]);
  });

  it('an endpoint that rejects output_config.format outright is remembered', async () => {
    const f = mockFetch(anthropicErr('output_config.format: Extra inputs are not permitted'), json(anthropicMessage('{"a":"x"}')));
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, ...fastRetry });
    await p.complete(simple);
    expect(p.disabledFeatures).toEqual(['format']);
    await p.complete(simple);
    expect(f.calls.map(formatOf)).toEqual([true, false, false]);
  });

  it('a schema error mentioning "beta" does not turn off fallbacks', async () => {
    const f = mockFetch(anthropicErr('output_config.format.schema.properties.beta: Schema is too complex'), json(anthropicMessage('{"a":"x"}')));
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, ...fastRetry });
    await p.complete(simple);
    expect(f.calls[1]!.body.fallbacks).toBe('default');
    expect(formatOf(f.calls[1]!)).toBe(false);
    expect(p.disabledFeatures).toEqual([]);
  });

  it('drops several features one at a time within a call, and stops', async () => {
    const f = mockFetch(
      anthropicErr('output_config.effort: Input should be low, medium or high'),
      anthropicErr('anthropic-beta: unknown beta header'),
      json(anthropicMessage('ok')),
    );
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, effort: 'xhigh', ...fastRetry });
    await p.complete({ ...simple, jsonSchema: undefined });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.body.output_config).toBeUndefined();
    expect(f.calls[2]!.body.fallbacks).toBeUndefined();
    expect(p.disabledFeatures.sort()).toEqual(['effort', 'fallbacks']);

    const g = mockFetch(anthropicErr('output_config.format.schema: Schema is too complex'));
    const err = await new AnthropicProvider({ apiKey: 'k1234', fetch: g, browser: false, refusalFallback: false, ...fastRetry }).complete(simple).catch((e) => e);
    expect(err.status).toBe(400);
    expect(g.calls).toHaveLength(2); // with and without the format, then the error surfaces
  });
});

describe('OpenAICompatibleProvider: per-request mode step-down', () => {
  const modeOf = (c: FetchCall) => c.body.response_format?.type ?? 'none';

  it("a schema the endpoint rejects steps down this call only", async () => {
    const f = mockFetch((c) =>
      c.body.response_format?.json_schema?.schema?.properties?.evil
        ? openaiErr("Invalid schema for response_format 'response': schema is too complex")
        : json(chatCompletion('{"a":"x"}')),
    );
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1234', fetch: f, structuredOutput: 'json_schema', ...fastRetry });
    await p.complete(complex);
    expect(f.calls.map(modeOf)).toEqual(['json_schema', 'json_object']);
    expect(p.structuredMode).toBe('json_schema');
    await p.complete(simple);
    expect(modeOf(f.calls[2]!)).toBe('json_schema');
  });

  it('an endpoint without json_schema support is remembered', async () => {
    const f = mockFetch(openaiErr("Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model"), json(chatCompletion('{"a":"x"}')));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1234', fetch: f, structuredOutput: 'json_schema', ...fastRetry });
    await p.complete(simple);
    expect(p.structuredMode).toBe('json_object');
    await p.complete(simple);
    expect(f.calls.map(modeOf)).toEqual(['json_schema', 'json_object', 'json_object']);
  });
});
