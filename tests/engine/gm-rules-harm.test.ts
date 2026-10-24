/**
 * GM rule harm accounting (issues/M2-gm-rule-harm-gamed.md, issues/M2-gm-remove-rule-total.md):
 * the estimate keeps harm and help apart and only credits help that is sure to reach the player;
 * retiring rules is checked against the GM total, ledgered and limited per area.
 * Moved here from tests/review/m2/round2.test.ts once passing.
 */
import { describe, it, expect } from 'vitest';
import type { GmAction } from '../../src/schema/gm';
import type { RuleVariant } from '../../src/schema/world';
import { applyGmActions, createGame } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { estimateRuleImpact } from '../../src/engine/rules';
import { DIFFICULTY_PROFILES } from '../../src/engine/difficulty';
import { testWorld, env, player, act, roomMap, simpleGenerator } from './helpers';

const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;
const add = (r: RuleVariant): GmAction => ({ type: 'add_rule', rule: r, reason: 'review' });
const remove = (id: string): GmAction => ({ type: 'remove_rule', id, reason: 'review' });
type Effects = RuleVariant['playerTriggers'][number]['action']['effects'];

function rule(id: string, over: Partial<RuleVariant> = {}): RuleVariant {
  return { id, name: id, description: `${id} rule`, playerTriggers: [], switches: {}, ...over };
}

function onTurn(every: number, effects: Effects, extra: Record<string, unknown> = {}, chance = 1) {
  return { on: 'on_turn' as const, every, chance, action: { targeting: self, effects, ...extra } };
}

const burn = (n: number) => ({ type: 'damage' as const, amount: { base: n }, damageType: 'physical' });
const mend = (n: number) => ({ type: 'heal' as const, amount: { base: n } });

function ids(s: GameState): string[] {
  return (s.activeRules ?? []).map((e) => e.rule.id);
}

function game(difficulty: GameState['difficulty'], w = testWorld()) {
  return createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty });
}

function waitN(w: ReturnType<typeof testWorld>, s: GameState, n: number): GameState {
  for (let i = 0; i < n && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
  return s;
}

describe('estimateRuleImpact cannot be gamed with help that never lands', () => {
  const w = testWorld();

  it('a heal behind a condition counts nothing; the burn alone is the harm', () => {
    const trap = rule('trap', {
      playerTriggers: [onTurn(1, [burn(2)]), onTurn(1, [mend(50)], { condition: { type: 'flag', flag: 'never_set_by_anyone' } })],
    });
    const imp = estimateRuleImpact(w, trap);
    expect(imp).toMatchObject({ hpPer100: 200, harm: 200, help: 0, harmful: true });
  });

  it('a heal behind a chance counts nothing (the burn still counts at its chance)', () => {
    const r = rule('r', { playerTriggers: [onTurn(1, [burn(1)], {}, 0.5), onTurn(1, [mend(5)], {}, 0.5)] });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 50, help: 0, hpPer100: 50 });
  });

  it('a heal aimed at enemies does not heal the player, and harm aimed at enemies does not hurt them', () => {
    const atFoes = { shape: 'all_visible', range: 0, radius: 0, affects: 'enemies', needsLos: true } as const;
    const r = rule('r', {
      playerTriggers: [onTurn(1, [burn(1)]), { ...onTurn(1, [mend(5), burn(9)]), action: { targeting: atFoes, effects: [mend(5), burn(9)] } }],
    });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 100, help: 0, hpPer100: 100 });
  });

  it('help that only may reach the player (an area that could miss) counts nothing, harm that may reach them counts', () => {
    const area = { shape: 'area', range: 3, radius: 1, affects: 'all', needsLos: true } as const;
    const r = rule('r', { playerTriggers: [{ ...onTurn(10, []), action: { targeting: area, effects: [mend(3), burn(1)] } }] });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 10, help: 0 });
  });

  it('a negative damage is nothing (the engine clamps it), not a heal', () => {
    const r = rule('r', { playerTriggers: [onTurn(1, [burn(2)]), onTurn(1, [{ type: 'damage', amount: { base: -50 }, damageType: 'physical' }])] });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 200, help: 0, hpPer100: 200 });
    const negHeal = rule('n', { playerTriggers: [onTurn(1, [{ type: 'heal', amount: { base: -3 } }])] });
    expect(estimateRuleImpact(w, negHeal)).toMatchObject({ harm: 0, help: 0, hpPer100: 0 });
  });

  it('one rare huge heal is capped per firing (hp cannot rise above the maximum)', () => {
    // 2 hp every turn against 200 hp every 100 turns: the heal is worth at most 30/4 per firing
    const r = rule('r', { playerTriggers: [onTurn(1, [burn(2)]), onTurn(100, [mend(200)])] });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 200, help: -7.5, hpPer100: 192.5 });
  });

  it('a sure counterweight still offsets (DESIGN: gentle needs a counterweight in the same rule)', () => {
    const r = rule('r', { playerTriggers: [onTurn(10, [burn(1)]), onTurn(10, [mend(1)])] });
    expect(estimateRuleImpact(w, r)).toMatchObject({ harm: 10, help: -10, hpPer100: 0 });
  });

  it('gentle refuses a rule with a never-firing heal and a real 2 hp/turn burn (round 2 repro)', () => {
    const s0 = game('gentle', w);
    const trap = rule('trap', {
      playerTriggers: [onTurn(1, [burn(2)]), onTurn(1, [mend(50)], { condition: { type: 'flag', flag: 'never_set_by_anyone' } })],
    });
    const r = applyGmActions(s0, [add(trap)], env(w));
    expect(r.gmSkipped?.[0]?.reason).toMatch(/too harsh for gentle/);
    expect(ids(r.state)).not.toContain('trap');
    const s = waitN(w, r.state, 10);
    expect(player(s).hp).toBe(player(s0).hp);
  });
});

describe('remove_rule respects ruleHarmTotal', () => {
  it('the net harm of GM rules never exceeds ruleHarmTotal (normal; round 2 repro)', () => {
    const w = testWorld();
    let s = game('normal', w);
    const nextArea = () => {
      s = structuredClone(s);
      s.area.gmRulesAdded = 0;
      s.area.gmRulesRemoved = 0;
      s.area.gmBudget = 99;
    };
    const steps: RuleVariant[] = [
      rule('mend', { playerTriggers: [onTurn(17, [mend(1)])] }), // ≈ -5.9
      rule('burn_a', { playerTriggers: [onTurn(17, [burn(1)])] }), // ≈ +5.9
      rule('burn_b', { playerTriggers: [onTurn(17, [burn(1)])] }), // ≈ +5.9
      rule('burn_c', { playerTriggers: [onTurn(25, [burn(1)])] }), // +4
    ];
    for (const r of steps) {
      nextArea();
      const res = applyGmActions(s, [add(r)], env(w));
      expect(res.gmSkipped, r.id).toEqual([]);
      s = res.state;
    }
    nextArea();
    const r = applyGmActions(s, [remove('mend')], env(w));
    expect(r.gmSkipped?.[0]?.reason).toMatch(/too harsh together for normal/);
    s = r.state;
    expect(ids(s)).toContain('mend');
    const total = (s.activeRules ?? []).filter((e) => e.source === 'gm').reduce((n, e) => n + estimateRuleImpact(w, e.rule).hpPer100, 0);
    expect(total).toBeLessThanOrEqual(DIFFICULTY_PROFILES.normal.ruleHarmTotal);
    // retiring a harmful GM rule is always fine (it lowers the total)
    expect(ids(applyGmActions(s, [remove('burn_a')], env(w)).state)).not.toContain('burn_a');
  });

  it('retiring helpful world rules is ledgered: several small ones cannot add up past the total', () => {
    // three world rules worth -5 each: each retirement is within ruleHarm (6), two are within the total (10)
    const w = testWorld((x) => {
      x.rules = ['w1', 'w2', 'w3'].map((id) => rule(id, { playerTriggers: [onTurn(20, [mend(1)])] }));
    });
    let s = game('normal', w);
    for (const id of ['w1', 'w2', 'w3']) {
      s = structuredClone(s);
      s.area.gmRulesRemoved = 0;
      s.area.gmBudget = 99;
      s = applyGmActions(s, [remove(id)], env(w)).state;
    }
    expect(ids(s)).toEqual(['w3']);
    expect(s.gmRetiredHarm).toBe(10);
    // the ledger also counts against adding: no harmful GM rule fits any more
    s.area.gmRulesAdded = 0;
    const r = applyGmActions(s, [add(rule('b', { playerTriggers: [onTurn(50, [burn(1)])] }))], env(w));
    expect(r.gmSkipped?.[0]?.reason).toMatch(/too harsh together/);
  });

  it('retiring a harmful world rule gives no credit for later harmful rules', () => {
    const w = testWorld((x) => {
      x.rules = [rule('ash', { playerTriggers: [onTurn(20, [burn(1)])] })];
    });
    let s = game('normal', w);
    s = applyGmActions(s, [remove('ash')], env(w)).state;
    expect(ids(s)).toEqual([]);
    expect(s.gmRetiredHarm ?? 0).toBe(0);
  });

  it('at most one retirement per area', () => {
    const w = testWorld((x) => {
      x.rules = ['w1', 'w2'].map((id) => rule(id));
    });
    const r = applyGmActions(game('normal', w), [remove('w1'), remove('w2')], env(w));
    expect(ids(r.state)).toEqual(['w2']);
    expect(r.gmSkipped).toEqual([{ action: 'remove_rule', reason: 'at most 1 retired rule per area' }]);
  });
});
