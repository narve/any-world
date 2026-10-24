/**
 * issues/M2-sim-tune-cannot-fix-too-easy.md: scaleAmount scales the mean and never collapses a base
 * to 0, hostile hp always moves, too_easy rounds push harder the further above the band a world is,
 * and between too_easy candidates the later (more corrected) round wins.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from '../engine/helpers';
import {
  scaleAmount,
  tooEasyFactor,
  preferCandidate,
  tuneDistance,
  rebalance,
  type BalanceReport,
  type StaticAnalysis,
} from '../../src/engine/balance';
import type { BotSummary } from '../../src/engine/sim/run';
import type { Amount } from '../../src/schema/world';

const mean = (a: Amount) => {
  const m = a.dice ? /^(\d+)d(\d+)$/.exec(a.dice) : null;
  return (a.base ?? 0) + (m ? (Number(m[1]) * (Number(m[2]) + 1)) / 2 : 0);
};

function summary(won: number, runs: number): BotSummary {
  return {
    bot: 'explorer',
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
const report = (verdict: BalanceReport['verdict'], won: number, runs = 120): BalanceReport =>
  ({
    world: 'x',
    difficulty: 'normal',
    verdict,
    winRate: won / runs,
    target: [0.25, 0.6],
    reasons: [],
    suggestions: [],
    static: { issues: [] as string[] } as StaticAnalysis,
    sims: [summary(won, runs)],
  }) as BalanceReport;

describe('scaleAmount scales the mean without collapsing', () => {
  it('keeps the old documented results', () => {
    expect(scaleAmount({ base: 4, dice: '2d6' }, 0.5)).toEqual({ base: 2, dice: '2d3' });
    expect(scaleAmount({ base: 1, dice: '1d2' }, 0.5)).toEqual({ base: 1, dice: '1d2' });
    expect(scaleAmount({ base: 0, dice: '1d8', scale: { stat: 'str', factor: 0.5 } }, 1.5)).toEqual({ base: 0, dice: '1d12', scale: { stat: 'str', factor: 0.75 } });
  });

  it('a base of 1 survives ×0.35 (the review repro) and the mean recovers on upscales', () => {
    const down = scaleAmount({ base: 1, dice: '1d4' }, 0.35);
    expect(down.base).toBe(1);
    expect(down.dice).toBe('1d2');
    let a = down;
    for (let i = 0; i < 3; i++) a = scaleAmount(a, 1.3);
    // 2.5 × 1.3³ ≈ 5.5: the base grows again (it used to stay 0 and end at 1d5 = 3)
    expect(a.base).toBeGreaterThanOrEqual(2);
    expect(mean(a)).toBeGreaterThanOrEqual(5);
  });

  it('the new mean is within one point of the scaled mean whenever the floors allow it', () => {
    const cases: Amount[] = [
      { base: 0, dice: '1d6' },
      { base: 2, dice: '1d8' },
      { base: 3, dice: '2d6' },
      { base: 5 },
      { base: 1, dice: '3d4' },
    ];
    for (const a of cases)
      for (const f of [0.7, 0.85, 1.15, 1.3, 1.6]) {
        const s = scaleAmount(a, f);
        expect(Math.abs(mean(s) - mean(a) * f)).toBeLessThanOrEqual(1);
        if (a.base) expect(s.base).toBeGreaterThanOrEqual(1);
        else expect(s.base).toBeGreaterThanOrEqual(0);
      }
  });

  it('negative bases keep their sign', () => {
    expect(scaleAmount({ base: -1 }, 0.3).base).toBe(-1);
    expect(scaleAmount({ base: -4 }, 1.5).base).toBe(-6);
  });
});

describe('too_easy rebalancing', () => {
  it('pushes harder the further above the band', () => {
    expect(tooEasyFactor(0.65, 0.6)).toBe(1.15);
    expect(tooEasyFactor(0.8, 0.6)).toBe(1.3);
    expect(tooEasyFactor(0.975, 0.6)).toBeGreaterThan(1.5);
    expect(tooEasyFactor(1, 0.25)).toBe(1.6);
  });

  it('hp 1 hostiles and ×0.35 worlds grow back', () => {
    const ship = loadFixture('fixture-ship.json');
    const w = structuredClone(ship);
    for (const a of w.actors) if (a.faction === 'hostile') {
      a.stats.hp = 1;
      if (a.attack) a.attack = { ...a.attack, damage: scaleAmount(a.attack.damage, 0.35) };
    }
    const r = rebalance(w, { verdict: 'too_easy', winRate: 0.975, target: [0.25, 0.6], sims: [] } as unknown as BalanceReport);
    expect(r.valid).toBe(true);
    for (const a of r.world.actors) {
      if (a.faction !== 'hostile') continue;
      expect(a.stats.hp).toBeGreaterThanOrEqual(2);
      if (a.attack && ship.actors.find((x) => x.id === a.id)!.attack!.damage.base) expect(a.attack.damage.base).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('preferCandidate', () => {
  it('a later too_easy round replaces an earlier one even when noise gives it a higher win rate', () => {
    const round1 = report('too_easy', 110); // 91.7%
    const round3 = report('too_easy', 114); // 95%
    expect(tuneDistance(round3)).toBeGreaterThan(tuneDistance(round1));
    expect(preferCandidate(round3, round1)).toBe(true);
  });

  it('otherwise ranks by tuneDistance', () => {
    expect(preferCandidate(report('too_easy', 100), report('ok', 50))).toBe(false);
    expect(preferCandidate(report('ok', 50), report('too_easy', 100))).toBe(true);
    expect(preferCandidate(report('too_hard', 10), report('too_hard', 20))).toBe(false);
  });
});
