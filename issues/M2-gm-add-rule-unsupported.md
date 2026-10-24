# GM add_rule / remove_rule were refused as 'unsupported'; no state.activeRules, no limits

- Severity: critical
- Area: engine (src/engine/gm.ts, new src/engine/rules.ts, ctx.ts, triggers.ts, stats/inventory/combat/turn switch reads)
- Status: fixed
- Covers three reports: playtest "GM can never add a rule" (critical), balance "add_rule/remove_rule unsupported" (major), reviewer r1 "add_rule puts the rule in force…" repro (major)

## Evidence
`applyGmActions(state, [{type:'add_rule', rule: simRule(), reason}])` logged "GM add_rule skipped: unsupported". `applyOne` had no case for either action. Switches were cached per world (`indexWorld(world).switches`), and player triggers were read from `world.rules`. The rules panel never changed in 4 bot runs, and sim --gm runs never exercised GM rules.

## Fix
- `GameState.activeRules: ActiveRuleEntry[]` (`{rule, source:'world'|'gm', since:{area,turn}, reason?}`). createGame seeds it with the world rules. Older saves without it play with world.rules, and the first GM change materializes the list.
- Switches come from `switchesOf(ctx)` (computed from the live list and cached on the context in `ctx.sw`, which is cleared on every change). Player rule triggers come from `activeRuleVariants(ctx)`. Every former `ctx.ix.switches` reader now uses `switchesOf`.
- add_rule: the rule is validated with the zod `RuleVariant`, its references are checked (statuses, actors, items, terrain, resources), and then `addRuleRefusal` checks for a duplicate id, `MAX_ACTIVE_RULES` (5), `MAX_GM_RULES_PER_AREA` (1, counted in `AreaState.gmRulesAdded`, which resets with each new area), the per-rule harm allowance for the difficulty, and the total harm of all GM rules. The power estimate is `estimateRuleImpact`, moved to src/engine/rules.ts. On success it logs the reason (kind 'gm') and "New rule: Name — description", and emits `rule_added`.
- remove_rule: the rule must be in force. Retiring a helpful rule counts as harm (−impact) and is checked against the same allowance. On success it logs "Rule lifted: Name" and emits `rule_removed`.
- Residue: when durability turns on mid-run, held and floor gear gets durability counters; when it turns off, the counters are deleted. Darkness, noLoot, noNaturalHpRegen, permadeathMercy and violenceCounter are read live. allConsumablesUnknown only decides knowledge at run start (documented in rules.ts).

## Regression test
tests/engine/gm-rules.test.ts (moved from tests/review/m2/round1.test.ts): add/remove with costs, events and log lines; triggers fire, then stop after removal; darkness on and off; durability residue; save/load; legacy state; the per-area limit, the 5-rule cap, duplicate/malformed/unknown-reference refusals; harm by difficulty (gentle needs a counterweight); retiring a helpful rule; total GM harm.
