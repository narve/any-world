# GM could win the run by creating a copy of the goal actor (spawn / summon of an actor_defeated def)

- Severity: critical
- Area: llm (src/llm/gm-checks.ts goalWriteProblem / effectGoalProblem); engine half open (see below)
- Status: fixed. GM checks refuse spawn / summon of goal and unique defs; M5 gate added the engine defence: an actor on the player's side (summoned or converted ally) gives no `defeated` credit when it dies (combat.finishKill), repro tests/review/m5/r3-code-gm-summon-goal.test.ts now passes.

## Evidence
tests/review/m5/r3-code-gm-summon-goal.test.ts. In nb-nordisk-noir-tromso (win = actor_defeated "ragnhild", the area-3 boss), gmActionProblems returned [] for `{type:'spawn', actor:'ragnhild'}` and for an `effect` on the player with `summon ragnhild allied`. The engine counts every death in defeated[defId] (combat.finishKill), whoever killed it, and lets the player bump an ally that never fights back: over seeds 1-5 the run was WON in area 0 after 28-48 bumps at full hp.

## Fix
New `creationProblem(world, refs, defId)` in gm-checks: the GM may not bring into being an actor whose def the goal or a lock names in actor_defeated, nor any `unique` def. It is applied to the `spawn` action, to `summon` effects (in `effect` actions, add_rule triggers and offer options, via effectGoalProblem) and to `transform` into a unique def (transform into a goal def was already refused). The GM prompt now says "actor ids for spawn and summon (never unique characters)" and the protected-goal line lists spawn / summon.

## Regression test
tests/llm/gm-fiat-r3.test.ts "GM creating a copy of the goal actor": spawn, allied and hostile summon, summon inside an offer and inside an add_rule trigger of "ragnhild" are each refused with a message naming it; a non-goal unique def is refused too; an ordinary hostile spawn is still accepted.

## Still open (engine owner)
tests/review/m5/r3-code-gm-summon-goal.test.ts keeps the engine half: applied WITHOUT the checks, an allied copy can be bumped to death for the win. Suggested: the player may not attack allies (or an attacked ally turns hostile), and/or a unique def that already exists in the run is not spawned again.
