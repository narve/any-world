# A unique actor spawned early and left behind never appears again, so a win that needs it becomes impossible

- Severity: major
- Area: engine (src/engine/actors.ts spawnActor)
- Status: fixed

## Evidence
`spawnActor` added a unique to `uniquesSpawned` on its first spawn and then refused it for the rest of the run. After a GM `spawn` of the unique `boss` in area 0 and a transition, area 1's `placed: [{actor:'boss'}]` was silently skipped. The `boss-down` win flag is set only by the boss's on_death, so the run could not be won. Spawn tables and summons in earlier areas trigger the same failure for fixture bosses. Repro: the review r2 test "a unique actor spawned early (GM spawn) and left behind...".

## Fix
Uniques are now tracked as "defeated" instead of "spawned". The new `uniqueSpawnable(ctx, defId)` allows a spawn when the unique has never been defeated (`s.defeated[defId]` is 0) and no living instance is in the current area. Areas are dropped on transition, so the current area holds the only live one, and allies carried along are already in the area before placement. `uniquesSpawned` is still filled as a record (the comment in types.ts is updated), so old saves stay compatible.

## Regression test
tests/engine/review-r2.test.ts, "review r2: uniques left behind can appear again" (reappears in area 1, never two alive at once, never after defeat).
