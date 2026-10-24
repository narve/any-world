# A GM rule that feeds the world's lose counter cost 0 harm and ended the run instantly, even on gentle

- Severity: critical
- Area: engine (src/engine/rules.ts effectHarm / addRuleRefusal)
- Status: fixed

## Evidence
tests/review/m2/round3.test.ts 'a rule that feeds the world lose counter is not free'. effectHarm had no case for 'counter' or 'set_flag' (returns 0). fixture-teen (lose: detentions >= 3) on gentle accepted add_rule on_turn {counter: detentions, add: 3}; a probe run was 'lost' at turn 1.

## Fix
New `goalRefs(world)` collects every counter and flag read by goal.win, goal.lose and each area's transitionRequires; `ruleGoalWrite(world, rule)` finds a counter/set_flag effect of the rule (directly or through the perTurn effects of a status it applies) that writes one of them. `addRuleRefusal` refuses such rules on every difficulty ("a rule may not change counter "detentions": the goal depends on it"). This also blocks the opposite exploit (a rule handing over the win). Counters/flags nothing in the goal reads stay allowed.

## Regression test
tests/engine/gm-rules-harm-r3.test.ts (moved from tests/review/m2/round3.test.ts): the teen 'doom' repro; plus goalRefs on teen, a private counter still allowed, and a set_flag on a flag the win condition reads refused with a reason even on brutal.
