/**
 * GM rule harm accounting, round 3 (issues/M2-gm-rule-clamped-dice.md, M2-gm-rule-scaled-amounts.md,
 * M2-gm-rule-goal-counter.md, M2-gm-rule-spawn-terrain.md, M2-gm-rule-spent-mercy.md): shapes the
 * estimate used to price at ~0 harm, so the GM could add them even on gentle.
 * Moved here from tests/review/m2/round3.test.ts once passing; regression tests added below.
 */
import { describe, it, expect } from 'vitest';
import type { GmAction } from '../../src/schema/gm';
import type { RuleVariant } from '../../src/schema/world';
import { applyGmActions, createGame, patchPlayer } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { estimateRuleImpact, expectedPositive, goalRefs, statCeiling } from '../../src/engine/rules';
import { testWorld, env, act, roomMap, simpleGenerator, loadFixture, player } from './helpers';

const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;
const add = (r: RuleVariant): GmAction => ({ type: 'add_rule', rule: r, reason: 'review r3' });
type Effects = RuleVariant['playerTriggers'][number]['action']['effects'];

function rule(id: string, over: Partial<RuleVariant> = {}): RuleVariant {
  return { id, name: id, description: `${id} rule`, playerTriggers: [], switches: {}, ...over };
}
function onTurn(every: number, effects: Effects) {
  return { on: 'on_turn' as const, every, chance: 1, action: { targeting: self, effects } };
}
const ids = (s: GameState) => (s.activeRules ?? []).map((e) => e.rule.id);

function game(difficulty: GameState['difficulty'], w = testWorld()) {
  return createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty });
}
function waitN(w: ReturnType<typeof testWorld>, s: GameState, n: number): GameState {
  for (let i = 0; i < n && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
  return s;
}

describe('GM rule harm: rolled amounts with a negative base are priced at their clamped mean', () => {
  // effectHarm uses max(0, mean(base + dice)). The engine rolls first and clamps each roll, so
  // {base:-50, dice:'1d99'} has mean 0 in the estimate but E[max(0, roll)] ≈ 12.4 hp per firing.
  const lottery = rule('lottery', { playerTriggers: [onTurn(1, [{ type: 'damage', amount: { base: -50, dice: '1d99' }, damageType: 'physical' }])] });

  it('the estimate sees the real expected damage', () => {
    expect(estimateRuleImpact(testWorld(), lottery).harm).toBeGreaterThan(100);
  });

  it('gentle refuses it (today it is accepted and kills the player within a few dozen turns)', () => {
    const w = testWorld();
    const r = applyGmActions(game('gentle', w), [add(lottery)], env(w));
    expect(ids(r.state)).not.toContain('lottery');
  });
});

describe('GM rule harm: scaled amounts assume every stat is 12', () => {
  // avgAmount uses statGuess=12, so base -12 + 1×hp prices at 0; the engine scales by the holder's
  // current hp (testWorld player: 30) → 18 damage on the first firing.
  const scaled = rule('scaled', { playerTriggers: [onTurn(5, [{ type: 'damage', amount: { base: -12, scale: { stat: 'hp', factor: 1 } }, damageType: 'physical' }])] });

  it('gentle refuses it', () => {
    const w = testWorld();
    const s0 = game('gentle', w);
    const r = applyGmActions(s0, [add(scaled)], env(w));
    const s = waitN(w, r.state, 6);
    // either refused, or (if accepted) it must not have cost more than the gentle allowance
    expect(ids(r.state)).not.toContain('scaled');
    expect(player(s).hp).toBeGreaterThan(player(s0).hp - 5);
  });
});

describe('GM rule harm: effects the estimator prices at 0', () => {
  it('a rule that feeds the world lose counter is not free (teen: detentions >= 3 loses)', () => {
    // effectHarm has no case for 'counter' (or 'set_flag'), so this costs 0 and passes even on
    // gentle; the next turn the run is lost.
    const w = loadFixture('fixture-teen.json');
    const doom = rule('doom', { playerTriggers: [onTurn(1, [{ type: 'counter', counter: 'detentions', add: 3 }])] });
    const s0 = createGame(w, { seed: 3, difficulty: 'gentle' });
    const r = applyGmActions(s0, [add(doom)], env(w));
    expect(ids(r.state)).not.toContain('doom');
  });

  it('spawning harmful terrain under the player every turn is priced as harm', () => {
    // testWorld 'spikes' deal 1 per turn stood on; spawn_terrain is not in effectHarm (0).
    const w = testWorld();
    const spiky = rule('spiky', { playerTriggers: [onTurn(1, [{ type: 'spawn_terrain', terrain: 'spikes', radius: 1 }])] });
    expect(estimateRuleImpact(w, spiky).harm).toBeGreaterThan(10);
  });
});

describe('GM rule harm: permadeathMercy counted as help when it can no longer help', () => {
  // The estimate always credits -maxHp/3 for permadeathMercy, even when the mercy was already used
  // (PlayerState.mercyUsed) or another rule already grants it. On normal (ruleHarm 6) a rule
  // "mercy + 1 damage every 7 turns" nets 14.3 - 10 = 4.3 and is accepted, but after the mercy is
  // spent it is a pure 14.3 hp/100t drain, over the per-rule allowance.
  it('normal refuses a mercy-counterweighted drain once the mercy is spent', () => {
    const w = testWorld();
    const s0 = patchPlayer(game('normal', w), { mercyUsed: true });
    const r = rule('fake_mercy', {
      playerTriggers: [onTurn(7, [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }])],
      switches: { permadeathMercy: true },
    });
    const res = applyGmActions(s0, [add(r)], env(w));
    expect(ids(res.state)).not.toContain('fake_mercy');
  });

  it('gentle refuses a mercy-counterweighted drain: Gentle already grants the second chance', () => {
    const w = testWorld();
    // 1 damage every 10 turns = 10 hp/100t, exactly what the mercy (30 hp / 3) would offset
    const r = rule('fake_mercy', {
      playerTriggers: [onTurn(10, [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }])],
      switches: { permadeathMercy: true },
    });
    expect(estimateRuleImpact(w, r).hpPer100).toBeLessThanOrEqual(1);
    const res = applyGmActions(game('gentle', w), [add(r)], env(w));
    expect(ids(res.state)).not.toContain('fake_mercy');
  });
});

// ---------------------------------------------------------------------------
// Regression tests around the fixes
// ---------------------------------------------------------------------------

describe('expectedPositive (clamped mean of a roll)', () => {
  it('is the plain mean when no roll can go below 0, and 0 when none can go above', () => {
    expect(expectedPositive(2, '1d6')).toBe(5.5);
    expect(expectedPositive(-10, '1d6')).toBe(0);
    expect(expectedPositive(3, undefined)).toBe(3);
    expect(expectedPositive(-3, undefined)).toBe(0);
  });

  it('is exact for small pools that straddle 0', () => {
    expect(expectedPositive(-50, '1d99')).toBeCloseTo(1225 / 99, 6);
    // 2d6 - 7: values 1..5 with probability 5,4,3,2,1 /36
    expect(expectedPositive(-7, '2d6')).toBeCloseTo((5 * 1 + 4 * 2 + 3 * 3 + 2 * 4 + 1 * 5) / 36, 6);
  });

  it('uses a close normal approximation for huge pools', () => {
    // symmetric around 0: E[max(0,X)] = sigma / sqrt(2 pi)
    const n = 99;
    const k = 999;
    const mu = (n * (k + 1)) / 2;
    const sigma = Math.sqrt((n * (k * k - 1)) / 12);
    expect(expectedPositive(-mu, `${n}d${k}`)).toBeCloseTo(sigma / Math.sqrt(2 * Math.PI), 0);
  });
});

describe('scaled amounts are priced from the world', () => {
  const w = testWorld();
  it('the ceiling of hp includes level growth', () => {
    expect(statCeiling(w, 'hp')).toBeGreaterThanOrEqual(w.player.stats.hp);
  });

  it('harm uses the top of the scale, help the bottom', () => {
    const hurt = rule('hurt', { playerTriggers: [onTurn(10, [{ type: 'damage', amount: { base: 0, scale: { stat: 'hp', factor: 0.5 } }, damageType: 'physical' }])] });
    expect(estimateRuleImpact(w, hurt).harm).toBeGreaterThanOrEqual(10 * 0.5 * w.player.stats.hp);
    // a heal of 0.5 × hp is worth nothing for sure (hp may be low when it fires)
    const mend = rule('mend', { playerTriggers: [onTurn(10, [{ type: 'heal', amount: { base: 1, scale: { stat: 'hp', factor: 0.5 } } }])] });
    expect(estimateRuleImpact(w, mend)).toMatchObject({ harm: 0, help: -10 });
  });

  it('a resource drain scaled by a custom resource reads its maximum', () => {
    const fx = loadFixture('fixture-ship.json');
    const res = fx.resources[0];
    if (!res) return;
    expect(statCeiling(fx, res.id)).toBe(res.max);
  });
});

describe('goal counters and flags are off limits to GM rules', () => {
  it('goalRefs collects win, lose and transition locks', () => {
    const w = loadFixture('fixture-teen.json');
    expect(goalRefs(w).counters.has('detentions')).toBe(true);
  });

  it('a counter nothing reads is still allowed (and harmless)', () => {
    const w = loadFixture('fixture-teen.json');
    const tally = rule('tally', { playerTriggers: [onTurn(10, [{ type: 'counter', counter: 'gm_private_tally', add: 1 }])] });
    const r = applyGmActions(createGame(w, { seed: 3, difficulty: 'gentle' }), [add(tally)], env(w));
    expect(ids(r.state)).toContain('tally');
  });

  it('setting a flag the win condition reads is refused with a reason', () => {
    const w = testWorld((x) => {
      x.goal.win = { type: 'any', of: [x.goal.win, { type: 'flag', flag: 'escaped' }] };
      // a world rule that can set it, so the world is valid
      x.rules = [{ id: 'exit_by_deeds', name: 'Deeds', description: 'd', playerTriggers: [{ on: 'on_kill', chance: 0.01, action: { targeting: self, effects: [{ type: 'set_flag', flag: 'escaped', value: true }] } }], switches: {} }];
    });
    const cheat = rule('cheat', { playerTriggers: [onTurn(1, [{ type: 'set_flag', flag: 'escaped', value: true }])] });
    const r = applyGmActions(game('brutal', w), [add(cheat)], env(w));
    expect(ids(r.state)).not.toContain('cheat');
    expect(r.gmSkipped?.[0]?.reason).toMatch(/flag "escaped"/);
  });
});

describe('spawned terrain', () => {
  it('harmless terrain costs nothing; rare spawns cost less than every-turn spawns', () => {
    const w = testWorld();
    const every1 = estimateRuleImpact(w, rule('a', { playerTriggers: [onTurn(1, [{ type: 'spawn_terrain', terrain: 'spikes', radius: 0 }])] })).harm;
    const every20 = estimateRuleImpact(w, rule('b', { playerTriggers: [onTurn(20, [{ type: 'spawn_terrain', terrain: 'spikes', radius: 0 }])] })).harm;
    expect(every1).toBeCloseTo(100, 0);
    expect(every20).toBeGreaterThan(0);
    expect(every20).toBeLessThan(every1);
  });
});

describe('permadeathMercy credit follows the state', () => {
  const mercyDrain = () =>
    rule('fake_mercy', {
      playerTriggers: [onTurn(7, [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }])],
      switches: { permadeathMercy: true },
    });

  it('normal still accepts the counterweighted drain while the mercy is unspent and not granted elsewhere', () => {
    const w = testWorld();
    const res = applyGmActions(game('normal', w), [add(mercyDrain())], env(w));
    expect(ids(res.state)).toContain('fake_mercy');
  });

  it('normal refuses it when a world rule already grants the mercy', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 'mercy', name: 'Mercy', description: 'd', playerTriggers: [], switches: { permadeathMercy: true } }];
    });
    const res = applyGmActions(game('normal', w), [add(mercyDrain())], env(w));
    expect(ids(res.state)).not.toContain('fake_mercy');
  });

  it('retiring a world mercy rule after the mercy is spent costs nothing', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 'mercy', name: 'Mercy', description: 'd', playerTriggers: [], switches: { permadeathMercy: true } }];
    });
    const s0 = patchPlayer(game('normal', w), { mercyUsed: true });
    const res = applyGmActions(s0, [{ type: 'remove_rule', id: 'mercy', reason: 'r3' }], env(w));
    expect(ids(res.state)).not.toContain('mercy');
    expect(res.state.gmRetiredHarm ?? 0).toBe(0);
  });
});
