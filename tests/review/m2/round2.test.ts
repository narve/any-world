/**
 * M2 adversarial review, round 2. Every test here FAILS on purpose against the current code; each
 * one is a confirmed bug (see the comment above it). Fixers: make them pass, do not delete them.
 */
import { describe, it, expect } from 'vitest';
import type { GmAction } from '../../../src/schema/gm';
import { responseCost } from '../../../src/client/gm-director';

// The GM add_rule / remove_rule harm repros moved to tests/engine/gm-rules-harm.test.ts once fixed.

describe('client GM: prototype-key action types (round 1, still open)', () => {
  // sanitizeResponse/responseCost still use `in` / `GM_ACTION_COST[type] ?? 0`; an inherited key
  // makes the client cost a NaN (offline director budget checks then always fail/succeed oddly).
  it('responseCost of an inherited-key action is a finite number', () => {
    expect(Number.isFinite(responseCost([{ type: 'constructor' } as unknown as GmAction]))).toBe(true);
  });
});
