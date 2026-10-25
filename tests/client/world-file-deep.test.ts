/**
 * Review M5 round 2 (code): importing an untrusted world file. parseWorldFile promises a typed
 * result for any input ("Imported files are untrusted"), but a 128 kB file — far under the 600 kB
 * MAX_WORLD_FILE_BYTES cap — whose goal nests 3000 `not` conditions makes parseWorld (zod's
 * recursive Condition) throw RangeError: Maximum call stack size exceeded. main.ts importWorld
 * calls it without a try/catch, so the import throws out of the file-input handler: no
 * "could not import" toast, just an uncaught error. The schema has no depth limit for conditions.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { jsonDepth, parseWorldFile, MAX_JSON_DEPTH, MAX_WORLD_FILE_BYTES } from '../../src/client/world-file';

function deepWorld(n: number): string {
  const w = JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8'));
  const deep = '{"type":"not","cond":'.repeat(n) + '{"type":"always"}' + '}'.repeat(n);
  w.goal.win = '@@DEEP@@';
  return JSON.stringify({ format: 'anyworld-world', version: 1, exportedAt: '2026-10-25T00:00:00Z', world: w }).replace(
    '"@@DEEP@@"',
    `{"type":"any","of":[{"type":"flag","flag":"speech-delivered"},${deep}]}`,
  );
}

describe('untrusted world file with deeply nested conditions', () => {
  it('parseWorldFile returns a typed failure instead of throwing', () => {
    const text = deepWorld(3000);
    expect(text.length).toBeLessThan(MAX_WORLD_FILE_BYTES);
    let thrown: string | null = null;
    let result: unknown = null;
    try {
      result = parseWorldFile(text);
    } catch (e) {
      thrown = `${(e as Error).name}: ${(e as Error).message}`;
    }
    expect(thrown).toBeNull();
    expect(result).toMatchObject({ ok: false });
  });
});

describe('world file nesting limit (issues/M5-import-deep-nesting.md)', () => {
  it('refuses a deep file with a typed invalid failure naming the nesting', () => {
    const r = parseWorldFile(deepWorld(3000));
    expect(r).toMatchObject({ ok: false, kind: 'invalid', key: 'world.import.error.invalid' });
    if (!r.ok) expect(r.details.join(' ')).toMatch(/nested too deeply/);
  });

  it('refuses just past the limit and still imports every shipped world', () => {
    expect(parseWorldFile(deepWorld(MAX_JSON_DEPTH))).toMatchObject({ ok: false, kind: 'invalid' });
    for (const f of readdirSync('content/worlds')) {
      const r = parseWorldFile(readFileSync(`content/worlds/${f}`, 'utf8'));
      expect(r.ok, f).toBe(true);
    }
  });

  it('jsonDepth walks iteratively and stops early past the limit', () => {
    expect(jsonDepth({ a: [1, { b: {} }] })).toBe(4);
    expect(jsonDepth('x')).toBe(0);
    let deep: unknown = {};
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(jsonDepth(deep, 10)).toBe(11);
  });
});
