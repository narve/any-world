/**
 * M2 adversarial review, round 1. Every test here FAILS on purpose against the current code; each
 * one is a confirmed bug (see the comment above it). Fixers: make them pass, do not delete them.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeResponse } from '../../../src/client/gm-director';

describe('GM: action types that are Object.prototype keys', () => {
  // sanitizeResponse keeps actions with `type in GM_ACTION_COST`; `in` walks the prototype chain, so
  // 'constructor' / 'toString' / '__proto__'… pass as "well-formed" GM actions.
  it('sanitizeResponse drops actions whose type is only an inherited key', () => {
    const r = sanitizeResponse({ actions: [{ type: 'constructor' }, { type: 'toString' }, { type: 'hasOwnProperty' }] });
    expect(r).toBeNull();
  });
});

// Moved once fixed (engine fixer, M2): the engine-side NaN-budget repros and the add_rule/remove_rule
// repro now live in tests/engine/gm-rules.test.ts; the rebalance repros in
// tests/balance/rebalance-rules.test.ts.
