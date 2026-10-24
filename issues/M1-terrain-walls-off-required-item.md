# Spawning blocking terrain during play can wall off the item the exit requires (permanent soft-lock)

- Severity: major
- Area: engine (src/engine/effects.ts spawnTerrain)
- Status: fixed

## Evidence
`spawnTerrain` only checked `exitReachable(player -> exit)`. A permanent non-walkable terrain (spawn_terrain without `duration`) on the only entrance of a pocket that held the `key` for area 0's `transitionRequires` was accepted. The key became unreachable and `transitionBlocker` stayed "Stairs: locked" forever. The same path is reached by GM `effect` spawn_terrain, actor abilities and items, and it can also wall off a win condition's placed items or actors. Repro: the review r2 test "non-walkable terrain spawned during play never cuts the player off...".

## Fix
For permanent blocking terrain, `spawnTerrain` now records BFS reachability from the player before the change. It rolls the placement back if any tile that was reachable before (other than the tiles just changed) is no longer reachable. That keeps every floor item, actor, transition-lock item and win-condition target reachable. It also covers future GM `place_item`/`spawn` with `near: random`, which may pick any floor tile. Temporary blocking terrain (with `duration`) still has only the exit check, because it expires and tactical walls must stay possible.

## Regression test
tests/engine/review-r2.test.ts, "review r2: spawned terrain never cuts the player off" (key pocket refused, empty pocket refused, open-room pillar allowed, temporary wall allowed).
