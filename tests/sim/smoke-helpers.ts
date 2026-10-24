/** Shared body of the bot smoke tests: every world file, N seeds per bot, no crashes or soft-locks. */
import { it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture } from '../engine/helpers';
import { runGame, type RunOptions, type SimResult } from '../../src/engine/sim/run';
import type { BotName } from '../../src/engine/sim/bots';

export const worldFiles = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();

export interface SmokePlan {
  bot: BotName;
  seeds: number;
  opts?: RunOptions;
  /** soft-locks allowed (random wanders: it may time out, but never crash) */
  allowStuck?: boolean;
}

function describeFailures(rs: SimResult[]): string {
  return rs
    .filter((r) => r.result === 'crash' || r.result === 'stuck' || r.stats.invalidLegal)
    .map((r) => `${r.bot} seed ${r.seed}: ${r.result} — ${r.cause} ${r.anomalies.join('; ')}`)
    .join('\n');
}

export function smoke(file: string, plans: SmokePlan[]): void {
  for (const plan of plans) {
    it(`${file}: ${plan.bot} × ${plan.seeds} seeds${plan.opts?.gm ? ' (scripted GM)' : ''} — no crashes${plan.allowStuck ? '' : ' or soft-locks'}`, { timeout: 180_000 }, () => {
      const world = loadFixture(file);
      const rs: SimResult[] = [];
      for (let seed = 1; seed <= plan.seeds; seed++) rs.push(runGame(world, seed, plan.bot, { fast: true, ...plan.opts }));
      const why = describeFailures(rs);
      expect(rs.filter((r) => r.result === 'crash').length, why).toBe(0);
      expect(rs.reduce((n, r) => n + r.stats.invalidLegal, 0), why).toBe(0);
      if (!plan.allowStuck) expect(rs.filter((r) => r.result === 'stuck').length, why).toBe(0);
      // every run made it somewhere and ended for a reason
      for (const r of rs) expect(r.cause.length).toBeGreaterThan(0);
    });
  }
}
