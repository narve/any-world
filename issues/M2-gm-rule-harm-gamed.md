# The GM rule harm estimate could be gamed: gentle accepted a rule doing 2 hp per turn

- Severity: critical
- Area: engine (src/engine/rules.ts estimateRuleImpact / effectHarm / addRuleRefusal)
- Status: fixed

## Evidence
tests/review/m2/round2.test.ts 'a rule with a never-firing heal...'. The rule had two on_turn triggers: damage 2 to self, and heal 50 gated by `action.condition {flag:'never_set_by_anyone'}`. `estimateRuleImpact` returned -4800 hp/100t ("very helpful"), so `addRuleRefusal` accepted it on gentle (ruleHarm 1), and the player lost 20 hp in 10 waits. The estimate ignored `Action.condition`, the trigger chance for helpful terms, and `targeting.affects` (a heal on enemies counted as healing the player). It also treated negative-base damage as healing, although `combat.dealDamage` clamps raw <= 0 to 0. It also gave a rare, huge heal full credit, even though heals cannot raise hp above the maximum.

## Fix
- `estimateRuleImpact` now keeps the two parts apart. `RuleImpact` gains `harm` (>= 0) and `help` (<= 0), and `hpPer100 = harm + help`.
  - Harm counts every hurtful effect that may reach the player, at the trigger's chance. Actor effects whose targeting rules out the user (`affects: 'enemies'` on a non-self shape) count nothing.
  - Help counts only certain effects: no `Action.condition` (or `always`), chance 1, and targeting that always includes the user (`shape: 'self'`, non-positional `self_only`, or `all_visible` + `allies`, which mirrors effects.resolveTargets). Each firing's help is capped at maxHp/4.
  - Every switch is harm. permadeathMercy is help.
- `effectHarm` clamps damage and heal amounts at 0, so a negative damage counts as nothing rather than as a heal.
- The per-rule check stays on the net value, because DESIGN §4.3 lets a harmful rule carry a counterweight in the same rule. Help that cannot be gamed is now the only help counted, so the net value is safe to use.

## Regression test
tests/engine/gm-rules-harm.test.ts, 'estimateRuleImpact cannot be gamed...'. It covers a heal behind a condition, a heal behind a chance, heals and damage aimed at enemies, area help that may miss, negative damage and negative heals, the per-firing cap on a rare huge heal, a sure counterweight that still offsets, and the round-2 repro on gentle (refused, no hp lost). The repro moved there from tests/review/m2/round2.test.ts.
