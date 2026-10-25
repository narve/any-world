# GM add_rule bypassed every fiat and help check (a 100000-damage on_turn trigger killed the goal boss)

- Severity: critical
- Area: llm (src/llm/gm-checks.ts boundProblem / goalWriteProblem / isHelpfulAction); engine power limit open
- Status: fixed. GM checks bound and refuse foe-striking rules; M5 gate added the engine defence: rules.addRuleRefusal refuses any GM rule whose player trigger reaches foes with damage / drain / kill / transform / faction / teleport or a negative resource or stat change (repro tests/review/m5/r3-code-gm-rule-fiat.test.ts passes).

## Evidence
tests/review/m5/r3-code-gm-rule-fiat.test.ts. fixture-teen area 2, Mags in sight: the 100000 damage as an `effect` action is refused, but as add_rule `{playerTriggers:[{on:'on_turn', action:{targeting:{shape:'all_visible', affects:'enemies'}, effects:[{type:'damage', amount:{base:100000}}]}}]}` it was accepted. boundProblem only bounded effect / trade / offer_choice, stateGoalProblem had no add_rule case, goalWriteProblem only checked flag / counter / stat / item writes, and estimateRuleImpact scores nothing aimed at enemies, so the rule was neither limited nor counted as help. The dry run saw nothing (the rule fires next turn); two waits later the boss was dead.

## Fix
- boundProblem: every Effect of every add_rule trigger goes through effectBoundProblem (GM_AMOUNT_LIMIT, and the new harmful-status duration cap).
- goalWriteProblem: an add_rule trigger whose targeting can land on the player's foes (shape not `self`, affects `enemies` or `all`) and that hurts, hinders or transforms is refused outright. A standing rule keeps firing in every later area, so "only while a goal actor is in this area" would not be enough; the prompt tells the GM to use a one-off effect instead.
- isHelpfulAction: such a rule counts as help (in case it ever gets through, e.g. from another caller).

## Regression test
tests/llm/gm-fiat-r3.test.ts "GM add_rule is held to the effect checks": the review repro (refused, counted as help, boss alive after two waits through the checked path), plus trigger amounts over 50 refused even on the player, a 2-damage foe rule refused (enemies and all), and a too-long harmful status inside a trigger refused.

## Still open (engine owner)
tests/review/m5/r3-code-gm-rule-fiat.test.ts keeps the engine half: applyGmActions WITHOUT the checks still accepts the rule (its power limit ignores triggers aimed at enemies). The runtime (gm-runtime keepValidActions) and the client recheck never take that path.
