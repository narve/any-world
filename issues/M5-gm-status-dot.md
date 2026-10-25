# GM could put a 200-turn harmful damage-over-time status on the player; the lethal check ignored statuses

- Severity: major
- Area: llm (src/llm/gm-checks.ts maxHpLoss / effectBoundProblem)
- Status: fixed

## Evidence
tests/review/m5/r3-code-gm-status-dot.test.ts. In folk-horror-scarecrow-wedding an `effect` on the player with `apply_status smouldering` (1d3 fire per turn) for 200 turns got no problems; a lone player at full hp who only waited was lost within 200 turns. maxHpLoss counted only `damage` and negative-hp `resource`. 13 bundled worlds have such statuses.

## Fix
- maxHpLoss(world, effects) now also counts harmful and other statuses as (per-turn hp loss x duration) plus their negative hp / maxHp modifiers (nested status applications counted to depth 2), and negative `modify_stat` on hp / maxHp. stateGoalProblem refuses the action when that total could reach the player's current hp (also used by the client's apply-time recheck).
- New GM_HARMFUL_STATUS_TURNS = 10 (goal-refs.ts, re-exported from gm-checks): a GM `effect` or add_rule trigger may apply a harmful status for at most 10 turns (world sources use about 5). Stated in the GM prompt.

## Regression test
tests/llm/gm-fiat-r3.test.ts "GM harmful damage-over-time status on the player": the 200-turn repro is refused; a 3-turn burn on a healthy player is allowed but refused at hp 4 (max 9); a -5 hp stat change at hp 3 is refused.
