# Terrain that re-applies a stun or root of 2 or more turns never lets it expire

- Severity: major
- Area: engine (src/engine/turn.ts endRound and runWorld)
- Status: fixed

## Evidence
`endRound` skipped re-applying only the statuses that had expired that round. `applyStatus` refreshes to `max(turnsLeft, turns)`, so a 2-turn status ticked to 1 and was topped back up to 2 every round. A 2-turn stun made one move advance `state.turn` by 1000, until the `runWorld` guard ran out. A 2-turn root left the player rooted forever. Shipped fixtures already have 2-turn onStand statuses and a rooting terrain.

## Fix
- Terrain onStand statuses never refresh. `apply_status` from terrain is skipped while the actor still has that status (from any source) and in the round it expires. A status of any length therefore runs out and leaves the player a round to act (to step off) before the terrain applies it again. Standing in fire still burns on most turns.
- `runWorld` no longer burns rounds silently. After `RUN_WORLD_GUARD` (2000) iterations it logs "<player> can act again." and returns control. Legitimately long stuns (about 200 turns) still resolve in one step.

## Regression test
tests/engine/review-r3.test.ts, "terrain statuses always run out": a 2-turn stun costs at most 5 turns, a 2- and 5-turn root lets the player step off, and staying on the terrain still re-applies the status.
