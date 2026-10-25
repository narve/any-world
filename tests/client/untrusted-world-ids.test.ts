/**
 * Review M5 round 1: imported (untrusted) world files. Ids are free-form lowercase strings, so
 * "constructor" is a valid flag/counter id; lookups in plain-object records must use own keys.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorldFile } from '../../src/client/world-file';
import { stateLabel } from '../../src/client/guide';

describe('goal labels with an Object.prototype id', () => {
  const raw = JSON.parse(readFileSync('content/worlds/fixture-ship.json', 'utf8'));

  it('an imported world whose goal labels some flags does not crash the goal tracker on a flag named "constructor"', () => {
    raw.goal.labels = { 'hull-sealed': 'The hull is sealed' };
    const r = parseWorldFile(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a world flag/counter id that happens to be "constructor" (valid Id: /^[a-z0-9][a-z0-9_-]*$/)
    expect(() => stateLabel(r.world, 'constructor')).not.toThrow();
    expect(stateLabel(r.world, 'constructor')).toBe('constructor');
  });
});
