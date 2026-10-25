# No cap on actors per area: a self-summoning actor with a low chance fills the map (~983 actors)

- Severity: major
- Area: engine (src/engine/actors.ts spawnActor, effects.ts summon, gm.ts spawn), schema (worldWarnings)
- Status: fixed (engine cap and warning). The balance-step time budget is still open: it lives in src/engine/balance and src/llm, which are not engine-fixer files.

## Evidence
tests/review/m5/r3-spreading-actor.test.ts: fixture-western, with dust-coyote made neutral and given an on_turn trigger {chance 0.03, summon itself, count 1}. Area 0 reached 983 actors (expected < 150). Every copy carries the trigger, so growth is exponential until `findFreeNear` finds no free tile. `worldWarnings()` returned []. `balanceWorld` (2 seeds, explorer) took 90 s and gave verdict "ok". The round-2 swarm (tests/review/m5/r2-hostile-generate.test.ts, chance 1, count 4) took 650 s for one balance seed.

## Fix
- `MAX_AREA_ACTORS = 60` living non-player actors per area (engine/actors.ts; shipped worlds peak at 16). `spawnActor` returns null once the area is full. The area's own placement (plan + spawn table, bounded by the plan) passes `uncapped: true`. Summons (effects.ts), trigger/rule summons and GM spawns are always capped.
- A GM `spawn` into a full area is skipped with the reason "the area is full (60 actors)" and is not placed.
- `worldWarnings` (schema/refs.ts) flags a non-unique actor that summons its own kind, directly or through a loop (A summons B, B summons A), from an ability or a repeating trigger. One-off triggers (on_death, on_low_hp) are not flagged.
- Result: the low-chance spreader peaks at 61 actors. The r2 swarm generate test now settles in about 7 s instead of 650 s.

## Regression test
tests/engine/m5-reach-cap.test.ts, "actor cap per area": the review repro (moved here from tests/review/m5/r3-spreading-actor.test.ts) covers the swarm staying at or below the cap while still swarming, the 300-turn run finishing quickly, the `spawnActor` cap and the `uncapped` bypass, the GM spawn rejection and the worldWarnings loop detection.
