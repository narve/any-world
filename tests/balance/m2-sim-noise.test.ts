/**
 * issues/M2-sim-tune-sampling-noise.md: verdicts are confidence-aware (Wilson interval), tuneWorld
 * re-checks verdicts and candidates on fresh seeds, and in-band worlds near the band centre win.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from '../engine/helpers';
import {
  staticAnalysis,
  verdictFor,
  wilsonInterval,
  tuneDistance,
  tuneWorld,
  confirmReport,
  seedList,
  TUNE_DEFAULT_SEEDS,
  type BalanceReport,
  type StaticAnalysis,
} from '../../src/engine/balance';
import { mergeSummaries, summarize, type BotSummary, type SimResult } from '../../src/engine/sim/run';

function summary(bot: string, won: number, runs = 20): BotSummary {
  return {
    bot,
    runs,
    won,
    lost: runs - won,
    stuck: 0,
    crash: 0,
    timeout: 0,
    winRate: won / runs,
    avgTurns: 500,
    avgTurnsWon: 500,
    deathsByCause: {},
    stuckCauses: {},
    timeoutCauses: {},
    crashCauses: {},
    areaHistogram: [runs - won, 0, won],
    avgKills: 5,
    avgLevel: 2,
    invalidLegal: 0,
    seeds: { won: [], lost: [], stuck: [], crash: [], timeout: [] },
  };
}
const clean = (sa: StaticAnalysis): StaticAnalysis => ({ ...sa, issues: [] });

describe('wilsonInterval', () => {
  it('matches the textbook values and stays inside 0..1', () => {
    const [a, b] = wilsonInterval(14, 20);
    expect(a).toBeCloseTo(0.516, 2);
    expect(b).toBeCloseTo(0.836, 2);
    expect(wilsonInterval(0, 20)[0]).toBe(0);
    expect(wilsonInterval(0, 20)[1]).toBeCloseTo(2.706 / 22.706, 3);
    expect(wilsonInterval(20, 20)[1]).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
    // more runs, narrower interval
    const w = (n: number) => wilsonInterval(n / 2, n);
    expect(w(100)[1] - w(100)[0]).toBeLessThan(w(20)[1] - w(20)[0]);
  });
});

describe('confidence-aware verdicts', () => {
  const teen = loadFixture('fixture-teen.json');
  const sa = clean(staticAnalysis(teen));

  it('a 20-seed window just outside the band is ok (sampling noise), not too_easy / too_hard', () => {
    // the review's windows: teen 14/20 and ship 13/20 at normal (100-seed means 55% / 51%)
    for (const won of [13, 14]) {
      const v = verdictFor(teen, sa, [summary('explorer', won)], 'normal');
      expect(v.verdict).toBe('ok');
      expect(v.reasons.join('\n')).toMatch(/within sampling noise \(90% interval \d+%–\d+% over 20 runs\)/);
      expect(v.interval![0]).toBeLessThan(0.6);
    }
    expect(verdictFor(teen, sa, [summary('explorer', 4)], 'normal').verdict).toBe('ok');
  });

  it('the same rate over more runs is confident', () => {
    expect(verdictFor(teen, sa, [summary('explorer', 84, 120)], 'normal').verdict).toBe('too_easy');
    expect(verdictFor(teen, sa, [summary('explorer', 8, 60)], 'normal').verdict).toBe('too_hard');
    const v = verdictFor(teen, sa, [summary('explorer', 0, 20)], 'normal');
    expect(v.verdict).toBe('too_hard');
    expect(v.runs).toBe(20);
  });
});

describe('tuneDistance prefers the band centre', () => {
  const report = (verdict: BalanceReport['verdict'], won: number, runs: number): BalanceReport =>
    ({
      world: 'x',
      difficulty: 'normal',
      verdict,
      winRate: won / runs,
      target: [0.25, 0.6],
      reasons: [],
      suggestions: [],
      static: { issues: [] as string[] } as StaticAnalysis,
      sims: [summary('explorer', won, runs)],
    }) as BalanceReport;

  it('an ok world whose interval covers the centre beats one on the band edge, and any ok beats too_hard / too_easy', () => {
    const centre = tuneDistance(report('ok', 26, 60)); // 43%
    const edge = tuneDistance(report('ok', 16, 60)); // 27%, interval 18–38%
    expect(centre).toBe(0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(0.1);
    expect(edge).toBeLessThan(tuneDistance(report('too_hard', 9, 60)));
    expect(edge).toBeLessThan(tuneDistance(report('too_easy', 45, 60)));
  });
});

describe('mergeSummaries', () => {
  it('pools two seed blocks exactly like summarize over both result sets', () => {
    const res = (seed: number, won: boolean, turns: number, area: number): SimResult => ({
      world: 'w',
      seed,
      bot: 'explorer',
      difficulty: 'normal',
      result: won ? 'won' : seed % 2 ? 'lost' : 'stuck',
      turns,
      steps: turns,
      areaReached: area,
      cause: won ? 'goal' : seed % 2 ? 'killed by x' : 'no progress',
      stats: { kills: seed, damageDealt: 0, damageTaken: 0, itemsUsed: 0, areasCleared: 0, level: 1 + (seed % 3), hpLow: 0, talks: 0, persuades: 0, interacts: 0, pickups: 0, equips: 0, gmBatches: 0, gmSkipped: 0, invalidLegal: 0, turnsPerArea: [] },
      anomalies: [],
    });
    const a = [res(1, true, 100, 2), res(2, false, 50, 0), res(3, false, 70, 1)];
    const b = [res(4, true, 300, 2), res(5, false, 20, 1)];
    const merged = mergeSummaries(summarize(a, 3), summarize(b, 3));
    const all = summarize([...a, ...b], 3);
    expect(merged).toHaveLength(1);
    const { seeds: ms, ...m } = merged[0];
    const { seeds: as, ...e } = all[0];
    expect(m).toEqual({ ...e, avgTurns: expect.closeTo(e.avgTurns, 9), avgTurnsWon: expect.closeTo(e.avgTurnsWon, 9), avgKills: expect.closeTo(e.avgKills, 9), avgLevel: expect.closeTo(e.avgLevel, 9) });
    for (const k of Object.keys(as) as (keyof typeof as)[]) expect([...ms[k]].sort()).toEqual([...as[k]].sort());
  });
});

describe('tuneWorld and sampling noise', () => {
  it('defaults to TUNE_DEFAULT_SEEDS seeds', () => {
    expect(TUNE_DEFAULT_SEEDS).toBeGreaterThanOrEqual(60);
    expect(seedList(undefined, TUNE_DEFAULT_SEEDS)).toHaveLength(TUNE_DEFAULT_SEEDS);
    expect(seedList(3, 99)).toEqual([1, 2, 3]);
  });

  it('leaves an in-band fixture alone when one 20-seed window looks too easy', { timeout: 300_000 }, () => {
    // review repro: tuneWorld(teen, { fast: true }) judged 14/20 as too_easy and hardened the world
    const teen = loadFixture('fixture-teen.json');
    const r = tuneWorld(teen, { seeds: 20, bots: ['explorer'], fast: true });
    if (r.history[0].verdict === 'ok') {
      expect(r.history).toHaveLength(1);
      expect(r.world).toBe(teen);
    } else {
      // only a verdict that held on a second, fresh seed block may change the world
      expect(r.history[0].runs).toBe(40);
    }
  });

  it('confirmReport pools fresh seeds into the verdict', { timeout: 300_000 }, () => {
    const ship = loadFixture('fixture-ship.json');
    const first = tuneWorld(ship, { seeds: 4, bots: ['explorer'], fast: true, rounds: 0, maxTurns: 300 }).report;
    const pooled = confirmReport(ship, first, { bots: ['explorer'], fast: true, maxTurns: 300 }, [5, 6, 7, 8]);
    expect(pooled.sims[0].runs).toBe(8);
    expect(pooled.runs).toBe(8);
    expect(pooled.sims[0].seeds.lost.concat(pooled.sims[0].seeds.won, pooled.sims[0].seeds.stuck, pooled.sims[0].seeds.timeout, pooled.sims[0].seeds.crash).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
