# GM 'effect' action deals unbounded damage, so the GM can defeat the goal boss and win the run by fiat

- Severity: major
- Area: llm (src/llm/gm-checks.ts)
- Status: fixed

## Evidence
tests/review/m5/r2-extreme-values.test.ts 'GM "effect" damage has no upper bound': in corporate-merger-kitchen (won by actor_defeated odile-greaves, 56 hp), with the boss next to the player, `{type:'effect', target:'nearest_enemy', effects:[{type:'damage', amount:{base:1000000}}]}` got `gmActionProblems → []` and `applyGmActions → status 'won'`. Amount.base is a bare z.number(); the help ceiling counts the action once whatever the amount. NPC dialogue replies go through the same checks.

## Fix
- `boundProblem(world, action)` (new, gm-checks): damage / heal / resource amounts in a GM `effect` (also inside offer options) are refused when `amountMax(amount)` (|base| + dice maximum + |scale.factor| x 20) exceeds `GM_AMOUNT_LIMIT` = 50. World-authored Effects keep the schema's own bounds; only GM / dialogue actions are limited.
- Goal-actor protection (see M5-gm-fiat-other-conditions): any harmful or transforming effect at enemies is refused while a living actor the goal or a lock names in actor_defeated is in the area, so even a 50-damage hit on the boss is refused.
- Every dry-run action whose result ends the run (won / lost) or lowers, kills, transforms or turns a goal actor is refused (`outcomeProblem`).

## Regression test
tests/llm/gm-fiat-r2.test.ts 'corporate-merger-kitchen: one GM action with damage 1e6 cannot win the run' and 'GM effect amounts are bounded'. The repro was removed from tests/review/m5/r2-extreme-values.test.ts (its other cases belong to other owners and stay).
