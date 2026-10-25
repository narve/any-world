# An id named "constructor" broke counters and defeat counts, so goals could never be met (soft-lock)

- Severity: major
- Area: engine (conditions, effects, combat, actors, goals, ai, knowledge, stats, turn, gm-context, index, ctx), schema (src/schema/world.ts Id)
- Status: fixed

## Evidence
The Id regex accepts "constructor". GameState counters/flags/defeated (and resources, knowledge,
cooldowns) are plain `{}` objects read as `obj[id] ?? 0`; for "constructor" that returns `Object`, the
increment stores "function Object() { [native code] }1" and every compare is NaN-false.
tests/review/m5/proto-ids.test.ts: viking-lawspeaker-althing with its counter renamed: wins 3 → 2 and
3 stuck runs (seeds 1-8, talker); corporate-merger-kitchen with the boss renamed: 5 wins → 3 stuck +
2 timeouts, and the unique boss respawned (`(defeated[id] ?? 0) > 0` NaN-false). `statName` also read
`vocabulary.stats.constructor` (Object) and showed "Object"; `knowledgeOf` returned `Object` as the
item's knowledge state.

## Fix
- `own(obj, key)` (src/engine/util.ts): own-property read, used for every id-keyed read of counters,
  flags, defeated, player resources, actor cooldowns, item knowledge and vocabulary stat names in the
  engine (not sim/balance/mapgen, which have their own owners).
- Schema: `Id` refuses `RESERVED_IDS` (constructor, prototype, __proto__) with the message "this id is
  reserved (built-in object key); pick another, e.g. add a suffix", so validateWorldRefs/parseWorld
  gives the model repair feedback.

## Regression tests
tests/engine/m5-robustness.test.ts "ids named like Object.prototype members": schema refusal with
feedback, `own()`, conditions/unique/knowledge/statName on "constructor", and the original repro
(moved from tests/review/m5/proto-ids.test.ts): the two worlds renamed to "constructor" after parsing
play exactly like "constructos", seed for seed.
