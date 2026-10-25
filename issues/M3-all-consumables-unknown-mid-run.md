# The GM rule "all consumables unknown" did nothing when added mid-run

- Severity: minor
- Area: engine (item knowledge)
- Status: fixed
- Source: BUILD_LOG.md [M3/engine]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
`allConsumablesUnknown` was only applied when a run started. When the GM added it during play (an add_rule
modifier), the items stayed identified, so the announced rule had no effect.

## Fix
When the rule comes into force, every clear consumable the player has neither used nor carries becomes unknown
(`ItemKnowledgeState.ruleHidden`) with an appearance from its group's pool. When no such rule is in force any
more, those items go back. World-start hiding is marked the same way. `item_identified` events are emitted.

## Regression tests
tests/engine/m3-engine.test.ts (allConsumablesUnknown rule mid-run, and retiring it).
