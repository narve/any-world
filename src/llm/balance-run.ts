/**
 * The automatic balance step of world generation (static analysis + bot simulations + rebalance),
 * kept in its own module so the bots and simulations load only when a world is balanced: in the
 * balance worker (balance-worker.ts), or on demand on the page when workers are unavailable.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty } from '../schema/gm';
import { tuneWorld } from '../engine/balance/index';
import type { BalanceOptions, BalanceOutcome } from './generate';

/** run the automatic balance step (static analysis + bots + rebalance) on a valid world */
export function balanceWorld(world: WorldSpec, difficulty: Difficulty, opts: BalanceOptions = {}): BalanceOutcome {
  const res = tuneWorld(world, {
    seeds: opts.seeds ?? 12,
    bots: opts.bots ?? ['explorer', 'cautious'],
    rounds: opts.rounds ?? 2,
    confirm: opts.confirm ?? true,
    difficulty,
    fast: true,
  });
  return { world: res.world, report: res.report, history: res.history.filter((h) => h.changes.length > 0) };
}
