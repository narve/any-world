/** GoalSpec.labels: flags and counters show their world-language label in the goal tracker, not the id. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { leafText, stateLabel, stepText } from '../../src/client/guide';

function load(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

describe('goal labels', () => {
  const bus = load('nb-russetid-bussen');
  it('a labelled flag reads in the world language', () => {
    expect(stateLabel(bus, 'kjopet-hevet')).toBe('Kjøpet av lydanlegget er hevet');
    expect(stepText(bus, undefined, { type: 'flag', flag: 'kjopet-hevet', value: true })).toContain('Kjøpet av lydanlegget er hevet');
    expect(leafText(bus, undefined, { type: 'flag', flag: 'kjopet-hevet', value: true })).not.toContain('kjopet');
  });

  it('a counter label is used too; unlabelled ids fall back to words', () => {
    const viking = load('viking-lawspeaker-althing');
    expect(stepText(viking, undefined, { type: 'counter', counter: 'thirds-recited', cmp: 'gte', value: 3 })).toContain('Thirds of the Law-Knot recited');
    expect(stateLabel(viking, 'some_other-flag')).toBe('some other flag');
  });

  it('every flag / counter a recorded world needs for its goal or locks has a label', () => {
    const missing: string[] = [];
    for (const f of readFileSync('content/prompts.json', 'utf8').match(/"worldId": "([^"]+)"/g) ?? []) {
      const id = f.split('"')[3]!;
      const w = load(id);
      const walk = (c: unknown): void => {
        if (!c || typeof c !== 'object') return;
        const o = c as Record<string, unknown>;
        if (o.type === 'flag' && !w.goal.labels?.[o.flag as string]) missing.push(`${id}: flag ${String(o.flag)}`);
        if (o.type === 'counter' && !w.goal.labels?.[o.counter as string]) missing.push(`${id}: counter ${String(o.counter)}`);
        for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
      };
      walk(w.goal.win);
      walk(w.goal.lose);
      for (const a of w.areas) walk(a.transitionRequires);
    }
    expect(missing).toEqual([]);
  });
});
