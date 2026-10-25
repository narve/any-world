# LLM GM (and NPC dialogue) can win the run instantly by setting the world's goal flag

- Severity: major
- Area: llm (src/llm/gm-checks.ts, src/llm/goal-refs.ts, src/llm/prompts/gm.ts, src/llm/prompts/dialogue.ts)
- Status: fixed

## Evidence
tests/review/m5/r1-gm-ceiling.test.ts 'an idle-hook GM answer in area 1 cannot win the run by setting the goal flag': fixture-teen wins on any[flag speech-delivered, ...]. A MockProvider GM reply `{actions:[{type:'set_flag',flag:'speech-delivered'}]}` passed gmResponseErrors and applyGmActions returned status 'won'. The same route let the GM open transitionRequires locks, force a loss through the goal counter (counter effect on `detentions`), or hand over a required item (give_item / place_item / spawn_item / quest reward). The dialogue prompt invited NPCs to use set_flag.

## Fix
New `src/llm/goal-refs.ts`: `goalRefs(world)` collects every flag, counter and has_item item that goal.win, goal.lose and each area's transitionRequires read (cached per world object). `gm-checks.goalWriteProblem(world, action, allowItems?)` refuses set_flag on such a flag (either value), counter / set_flag / spawn_item effects on them (also inside `effect` actions, offer_choice options and add_rule triggers, plus a rule's `violenceCounter` switch), and give_item / place_item / quest-reward of a goal or lock item. `gmActionProblems` runs it for every action before the engine dry run, so the model gets a repair turn ("refused: flag "speech-delivered": the world's goal or an area lock depends on it ...") and salvage / keepValidActions drop the action. Dialogue passes the speaking NPC's own stock as `allowItems`: a world that stocks a key with an NPC still lets that NPC hand it over. The GM and dialogue system prompts list the protected flags, counters and items (`protectedGoalLine`).

## Regression test
tests/llm/gm-ceiling.test.ts (moved from tests/review/m5/r1-gm-ceiling.test.ts): the original repro, plus every refused shape, a repair turn that keeps only the narration, a GM that cannot force a loss through `detentions`, the dialogue NPC-stock exemption, and the prompt lines.
