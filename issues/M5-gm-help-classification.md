# isHelpfulAction misses clearly helpful GM actions (damaging enemies, befriending hostiles)

- Severity: minor
- Area: llm (src/llm/gm-checks.ts)
- Status: fixed

## Evidence
tests/review/m5/r1-gm-ceiling.test.ts: isHelpfulAction returned false for `effect` on all_visible_enemies / nearest_enemy with damage 40, and for change_faction to friendly. Only effects on the player counted, so the GM could thin out or turn every enemy in an area without touching the help ceiling.

## Fix
isHelpfulAction(world, action, state?) now also counts: effects aimed at enemies that damage, apply a harmful status, lower a stat or resource, or turn them non-hostile; change_faction to neutral / friendly (when a state is given, only if that actor is hostile now); spawning a friendly non-NPC actor (an ally); start_quest with at least one reward; player effects that spawn a useful item or summon an ally. offer_choice passes the state through. The GM prompt's help-ceiling line names the new categories. The old test that asserted "damaging the nearest enemy is not helpful" was corrected.

## Regression test
tests/llm/gm-ceiling.test.ts: the three original cases, plus change_faction with state (hostile vs. already calm actor), quests with and without rewards, a weakening debuff vs. healing an enemy, an allied spawn, and applyHelpCeiling charging a pacification.
