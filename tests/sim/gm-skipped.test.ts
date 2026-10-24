/**
 * The sim counts refused GM actions from `gm_skipped` events (the engine no longer logs them as
 * 'system' messages, so the old message match always gave 0).
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from '../engine/helpers';
import { runGame } from '../../src/engine/sim/run';

describe('sim: SimStats.gmSkipped', () => {
  it('counts gm_skipped events from the scripted GM', () => {
    const world = loadFixture('fixture-ship.json');
    let batches = 0;
    let skipped = 0;
    for (let seed = 1; seed <= 2; seed++) {
      const r = runGame(world, seed, 'explorer', { gm: true, maxTurns: 1500, invariants: false });
      expect(r.result).not.toBe('crash');
      batches += r.stats.gmBatches;
      skipped += r.stats.gmSkipped;
    }
    expect(batches).toBeGreaterThan(0);
    // the scripted GM always tries a second add_rule in some area (1 GM rule per area) or runs over budget
    expect(skipped).toBeGreaterThan(0);
  }, 120_000);
});
