# A non-hostile NPC whose defeat the goal needs could not be attacked

- Severity: major
- Area: engine (legalActions, src/engine/goals.ts)
- Status: fixed
- Source: BUILD_LOG.md [M3/engine]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Some agent-authored worlds win on `actor_defeated` of an NPC that starts neutral or friendly (a boss you can
also talk to). `legalActions` only listed `attack` on hostiles, so bots and the context bar never offered the
attack and that win route was unreachable without a faction change.

## Fix
`legalActions` lists `attack` on a non-hostile actor whose defeat the run still needs: an `actor_defeated` in a
positive position of `goal.win`, a remaining lock or an active quest, matched by def id or `formerDefIds`, while
the count is not reached. The condition walk lives in the new src/engine/goals.ts (progressRefs,
requiredDefeats) and is shared with the trader and the GM context.

## Regression tests
tests/engine/m3-engine.test.ts, describe 'legalActions: attacks the goal needs'.
