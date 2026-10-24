import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { findOpenObjects, sanitizeSchemaForAnthropic, supportsAnthropicNativeSchema } from '../../src/llm/json-schema';
import { toJsonSchema } from '../../src/llm/structured';
import { AnthropicProvider } from '../../src/llm/anthropic';
import { AreaPlan } from '../../src/schema/world';
import { anthropicMessage, json, mockFetch } from './helpers';

const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'go' }], purpose: 'test' };

describe('Anthropic schema handling of records (M1 issue: sanitizer closed z.record to {})', () => {
  const withRecord = toJsonSchema(z.object({ name: z.string(), params: z.record(z.string(), z.number()) }));

  it('finds records, catchalls, patternProperties and bare objects', () => {
    expect(findOpenObjects(withRecord)).toEqual(['/properties/params']);
    expect(findOpenObjects({ type: 'object' })).toEqual(['#']);
    expect(findOpenObjects({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } })).toEqual(['#']);
    expect(findOpenObjects({ type: 'object', patternProperties: { '^x': { type: 'string' } } })).toEqual(['#']);
    expect(findOpenObjects({ type: 'array', items: { type: 'object', additionalProperties: {} } })).toEqual(['/items']);
    // closed objects, and objects with properties but no additionalProperties keyword, are fine
    expect(findOpenObjects(toJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number() }) })))).toEqual([]);
    expect(findOpenObjects({ type: 'object', properties: { a: { type: 'string' } } })).toEqual([]);
    // a property *named* additionalProperties is not the keyword
    expect(findOpenObjects({ type: 'object', properties: { additionalProperties: { type: 'object', properties: { x: { type: 'string' } } } }, additionalProperties: false })).toEqual([]);
  });

  it('never silently turns a record into a closed empty object', () => {
    expect(supportsAnthropicNativeSchema(withRecord)).toBe(false);
    expect(() => sanitizeSchemaForAnthropic(withRecord)).toThrow(/open objects.*\/properties\/params/);
    const plan = toJsonSchema(AreaPlan);
    expect(findOpenObjects(plan).some((p) => p.endsWith('/params'))).toBe(true);
  });

  it('sends schemas with records as prompt-only JSON (the record stays in the prompt schema)', async () => {
    const f = mockFetch(json(anthropicMessage('{"name":"a","params":{"density":0.4}}')));
    const p = new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, refusalFallback: false });
    const r = await p.complete({ ...req, jsonSchema: withRecord });
    expect(JSON.parse(r.text).params.density).toBe(0.4);
    const body = f.calls[0]!.body;
    expect(body.output_config).toBeUndefined();
    expect(body.system).toContain('"params"');
    expect(body.system).toContain('"additionalProperties":{"type":"number"}');
  });

  it('still uses native output for closed, non-recursive schemas', async () => {
    const s = toJsonSchema(z.object({ name: z.string(), hp: z.number().int().min(0) }));
    expect(supportsAnthropicNativeSchema(s)).toBe(true);
    const f = mockFetch(json(anthropicMessage('{"name":"a","hp":1}')));
    await new AnthropicProvider({ apiKey: 'k1234', fetch: f, browser: false, refusalFallback: false }).complete({ ...req, jsonSchema: s });
    expect(f.calls[0]!.body.output_config.format.schema.additionalProperties).toBe(false);
  });
});
