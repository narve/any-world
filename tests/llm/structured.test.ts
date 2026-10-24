import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { completeStructured, extractJson, relaxJson, StructuredOutputError, toJsonSchema, repairMessage } from '../../src/llm/structured';
import { MockProvider } from '../../src/llm/mock';
import { LLMAuthError, LLMRateLimitError } from '../../src/llm/errors';
import { WorldSpec, validateWorldRefs } from '../../src/schema';
import type { LLMProvider } from '../../src/llm/types';

const Thing = z.object({ name: z.string().min(1), hp: z.number().int().positive(), tags: z.array(z.string()).default([]) });
const req = { system: 'Make a thing.', messages: [{ role: 'user' as const, content: 'a goblin-ish thing' }], purpose: 'thing' };

describe('extractJson', () => {
  it('handles bare JSON, fences, leading/trailing prose, trailing commas, comments', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2,],}\n```\nEnjoy!')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(extractJson('Sure! The world is {"a": {"b": "}"}} — hope you like it.')).toEqual({ ok: true, value: { a: { b: '}' } } });
    expect(extractJson('<think>let me think {</think>{"x": true}')).toEqual({ ok: true, value: { x: true } });
    expect(extractJson('{\n  // name\n  "a": "http://x/y", /* c */ "b": 2\n}')).toEqual({ ok: true, value: { a: 'http://x/y', b: 2 } });
    expect(extractJson('[note] then [1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(extractJson('﻿{"bom":1}')).toEqual({ ok: true, value: { bom: 1 } });
  });

  it('reports truncated and missing JSON readably', () => {
    const t = extractJson('{"a": {"b": 1');
    expect(t.ok).toBe(false);
    expect(!t.ok && t.error).toMatch(/incomplete/);
    const n = extractJson('I cannot do that.');
    expect(!n.ok && n.error).toMatch(/did not contain/);
    expect(extractJson('   ').ok).toBe(false);
  });

  it('relaxJson leaves commas and slashes inside strings alone', () => {
    expect(relaxJson('{"a": "x,}", "u": "a//b",}')).toBe('{"a": "x,}", "u": "a//b"}');
  });
});

describe('completeStructured', () => {
  it('returns the parsed value on the first valid reply', async () => {
    const mock = new MockProvider({ responses: { thing: '```json\n{"name":"Grub","hp":3}\n```' } });
    const r = await completeStructured(mock, req, Thing);
    expect(r.value).toEqual({ name: 'Grub', hp: 3, tags: [] });
    expect(r.attempts).toBe(1);
    expect(r.model).toBe('mock');
  });

  it('repairs: feeds readable zod errors back and sums usage', async () => {
    const mock = new MockProvider({
      responses: {
        thing: [
          { text: '{"name":"","hp":-2}', usage: { inputTokens: 10, outputTokens: 5 } },
          { text: 'not json at all', usage: { inputTokens: 20, outputTokens: 3 } },
          { text: '{"name":"Grub","hp":2,"tags":["x"]}', usage: { inputTokens: 30, outputTokens: 7 } },
        ],
      },
    });
    const seen: boolean[] = [];
    const r = await completeStructured(mock, req, Thing, { retries: 2, onAttempt: (a) => seen.push(a.ok) });
    expect(r.value.name).toBe('Grub');
    expect(r.attempts).toBe(3);
    expect(r.usage).toEqual({ inputTokens: 60, outputTokens: 15 });
    expect(seen).toEqual([false, false, true]);
    // second call: original messages + echoed bad reply + repair note with paths
    const second = mock.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: '{"name":"","hp":-2}' });
    expect(second.messages[2]!.role).toBe('user');
    expect(second.messages[2]!.content).toMatch(/^- name: /m);
    expect(second.messages[2]!.content).toMatch(/^- hp: /m);
    // third call repairs the latest failure only (history does not grow)
    expect(mock.calls[2]!.messages).toHaveLength(3);
    expect(mock.calls[2]!.messages[2]!.content).toContain('did not contain a JSON object');
  });

  it('runs the extra validator and feeds its errors into the repair loop', async () => {
    const mock = new MockProvider({ responses: { thing: ['{"name":"Bad","hp":1}', '{"name":"Good","hp":1}'] } });
    const r = await completeStructured(mock, req, Thing, {
      validate: (v) => (v.name === 'Bad' ? ['name: "Bad" is a reserved word'] : []),
    });
    expect(r.value.name).toBe('Good');
    expect(mock.calls[1]!.messages[2]!.content).toContain('"Bad" is a reserved word');
  });

  it('throws StructuredOutputError with the last errors when retries run out', async () => {
    const mock = new MockProvider({ responses: { thing: '{"name":1}' } });
    const err = await completeStructured(mock, req, Thing, { retries: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect(err.attempts).toBe(2);
    expect(err.errors.length).toBeGreaterThan(0);
    expect(err.lastText).toBe('{"name":1}');
    expect(mock.calls).toHaveLength(2);
  });

  it('adds a be-concise hint when the reply was truncated', async () => {
    const mock = new MockProvider({ responses: { thing: [{ text: '{"name":"G', stopReason: 'max_tokens' }, '{"name":"G","hp":1}'] } });
    await completeStructured(mock, req, Thing);
    expect(mock.calls[1]!.messages[2]!.content).toContain('Be more concise');
  });

  it('treats an empty reply as repairable, but propagates transport errors', async () => {
    const empty = new MockProvider({ failure: { mode: 'empty', failFirst: 1 }, responses: { thing: '{"name":"A","hp":1}' } });
    expect((await completeStructured(empty, req, Thing)).attempts).toBe(2);
    expect(empty.calls[1]!.messages).toHaveLength(2); // no assistant echo for an empty reply

    const auth: LLMProvider = { id: 'x', model: 'x', complete: async () => { throw new LLMAuthError('bad key'); } };
    expect(await completeStructured(auth, req, Thing).catch((e) => e)).toBeInstanceOf(LLMAuthError);
    const rl = new MockProvider({ failure: { mode: 'rate_limit', failFirst: 1 } });
    expect(await completeStructured(rl, req, Thing).catch((e) => e)).toBeInstanceOf(LLMRateLimitError);
  });

  it('caps the quoted errors in the repair message', () => {
    const msg = repairMessage(Array.from({ length: 50 }, (_, i) => `e${i}`), false, 10);
    expect(msg).toContain('- e9');
    expect(msg).not.toContain('- e10');
    expect(msg).toContain('40 more');
  });

  it('repairs a World Spec with a dangling reference using validateWorldRefs', async () => {
    const world = JSON.parse(readFileSync('content/worlds/fixture-ship.json', 'utf8'));
    const broken = structuredClone(world);
    broken.player.startingItems = [...(broken.player.startingItems ?? []), { item: 'no_such_item_xyz' }];
    const mock = new MockProvider({ responses: { world: [JSON.stringify(broken), 'Fixed:\n```json\n' + JSON.stringify(world) + '\n```'] } });
    const r = await completeStructured(mock, { ...req, purpose: 'world' }, WorldSpec, { validate: validateWorldRefs });
    expect(r.attempts).toBe(2);
    expect(r.value).toEqual(WorldSpec.parse(world));
    expect(mock.calls[1]!.messages.at(-1)!.content).toContain('no_such_item_xyz');
  });

  it('toJsonSchema produces a JSON Schema object for providers', () => {
    const s = toJsonSchema(Thing) as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(s.type).toBe('object');
    expect(Object.keys(s.properties)).toEqual(['name', 'hp', 'tags']);
    expect(s.required).toContain('name');
    expect(s.required).not.toContain('tags'); // input side: defaulted fields are optional
  });
});
