/**
 * MP1 B4: a short smoke run with the largest party (12 bots) on one world: no crash, no invariant
 * break, no illegal refusal, every player acts, and the injected clock gives turn times with the
 * engine's share. The full run with turn times is `npx tsx tools/sim.ts --world
 * content/worlds/fixture-western.json --party 12 --seeds 1 --timing` (docs/progress/MP1.md).
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { loadFixture } from '../engine/helpers';
import { MAX_PARTY_SIZE } from '../../src/engine';
import { partyBots, runParty, timeStats } from '../../src/engine/sim/party';
import type { PlayerId } from '../../src/engine/types';

describe('a party of 12', () => {
  it('fixture-western: 12 bots play 150 rounds without a crash or an illegal refusal', () => {
    const world = loadFixture('fixture-western.json');
    const acted = new Set<PlayerId>();
    const r = runParty(world, 1, partyBots(['explorer', 'cautious', 'talker', 'newbie'], MAX_PARTY_SIZE), {
      fast: true,
      maxTurns: 150,
      now: () => performance.now(),
      onTurn: (i) => {
        for (const o of i.result.outcomes) if (o.ok && o.tookTurn) acted.add(o.playerId);
      },
    });
    expect(r.partySize).toBe(12);
    expect(r.result, r.cause).not.toBe('crash');
    expect(r.anomalies).toEqual([]);
    expect(r.refusals.illegal).toBe(0);
    expect(acted.size).toBe(12);
    const t = r.timing!;
    expect(t.turnMs.length).toBe(r.partyTurns);
    const engine = timeStats(t.engineMs);
    expect(engine.n).toBe(r.partyTurns);
    expect(engine.mean).toBeGreaterThan(0);
    expect(engine.mean).toBeLessThanOrEqual(timeStats(t.turnMs).mean);
  });
});
