/**
 * M5 gate: LLM replies are untrusted like imported world files (issues/M5-import-deep-nesting.md):
 * a reply nesting conditions thousands of levels deep is a readable validation error for the repair
 * turn, not a RangeError from zod's recursive schemas.
 */
import { describe, expect, it } from 'vitest';
import { checkStructuredText } from '../../src/llm/structured';
import { WorldSpec } from '../../src/schema/world';
import { MAX_JSON_DEPTH, jsonDepth } from '../../src/schema/json-depth';

function nested(levels: number): string {
  let cond = '{"type":"always"}';
  for (let i = 0; i < levels; i++) cond = `{"type":"not","cond":${cond}}`;
  return `{"meta":{"title":"Deep"},"rules":[{"id":"r","name":"R","when":${cond}}]}`;
}

describe('checkStructuredText nesting guard', () => {
  it('refuses a deeply nested reply with a readable error', async () => {
    const r = await checkStructuredText(nested(20000), WorldSpec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/nested too deeply/);
  });

  it('lets ordinary nesting through to the schema check', async () => {
    const r = await checkStructuredText(nested(3), WorldSpec);
    expect(r.ok).toBe(false); // not a valid world, but the schema (not the guard) says so
    if (!r.ok) expect(r.errors.join(' ')).not.toMatch(/nested too deeply/);
  });

  it('measures depth iteratively and stops past the limit', () => {
    expect(jsonDepth({ a: [{ b: 1 }] })).toBe(3);
    expect(jsonDepth(JSON.parse(nested(20000)), MAX_JSON_DEPTH)).toBeGreaterThan(MAX_JSON_DEPTH);
  });
});
