# LLM GM can still win, lose or soft-lock the run by fiat through actor_defeated, player hp and stat conditions

- Severity: major
- Area: llm (src/llm/goal-refs.ts, src/llm/gm-checks.ts)
- Status: fixed

## Evidence
tests/review/m5/r2-code-gm-fiat.test.ts (4 failing): fixture-teen area 2 with Mags Calloway in sight, a 100000-damage effect at all_visible_enemies passed the checks and won the run; a transform of the boss passed and made actor_defeated unreachable; a 100000-damage effect on the player lost the run; on abstract-yellow-triangle (lose: stat varnish gte 100) a resource varnish +100 effect lost the run. goalRefs only collected flag, counter and has_item.

## Fix
- `goalRefs` also collects `actors` (actor_defeated in goal.win, goal.lose and every transitionRequires) and `stats` (stat conditions). `protectedGoalLine` names them in the GM and dialogue prompts (and always states that no action may win or lose the run outright, no lethal damage to the player), so the model gets the rule up front and the refusals come back as repair feedback.
- `goalWriteProblem`: resource / modify_stat effects on a protected stat, transform into a goal actor def, and change_faction naming a goal actor def are refused.
- `stateGoalProblem(world, state, action)` (new): harmful (hindersTarget) or transform effects at enemies are refused while a living goal actor is in the area (targets are chosen when the action lands, so the whole area counts, not just what is visible now); change_faction on a goal actor instance is refused; player-targeted damage (and negative hp resource) whose maximum could reach the player's current hp is refused.
- `gmActionProblems` dry run: an action whose result ends the run or harms, kills, transforms or turns a goal actor is refused (`outcomeProblem`), as a catch-all for paths the static checks do not see.

## Known limit
A harmful status with a long damage-over-time could still wear the player down later; amounts are bounded (GM_AMOUNT_LIMIT) and the per-area budget / ceiling apply.

## Regression test
tests/llm/gm-fiat-r2.test.ts 'GM fiat through actor_defeated', 'GM fiat on the player and stat lose conditions', 'goal refs cover actor_defeated and stat conditions'. The review repro file was moved there.
