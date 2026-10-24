# Positional items that only affect the user skip all range and line-of-sight checks (teleport anywhere, even into sealed pockets)

- Severity: major
- Area: engine (src/engine/effects.ts resolveTargets / teleport, src/engine/inventory.ts useFailure)
- Status: fixed

## Evidence
`resolveTargets` returned early for `affects: 'self_only'` and accepted any `targetPos`. `useFailure` validated only when `affects !== 'self_only'`. A Blink item `{shape:'single', range:3, affects:'self_only'}` with `teleport to_target`, used on (16,5) behind a solid wall, moved the player to (16,5). Summon, spawn_item and spawn_terrain had the same hole. When the target was a disconnected pocket, the exit became unreachable: a soft-lock.

## Fix
- `resolveTargets` now runs the shape's normal resolution (bounds, range, line of sight) for every positional shape. `self_only` only filters who is affected: the result's actors are replaced with `[user]`. A self_only ray or cone with no aim still acts where the user stands, as before. Non-positional self_only shapes are unchanged.
- `useFailure` validates every positional item, self_only included.
- `teleport to_target` onto the user refuses destinations that are out of sight of the aimed spot (it can still pick a tile in sight nearby). For the player, it also refuses any destination from which the exit is unreachable (`exitReachable`). This holds even for a wall-ignoring (`needsLos: false`) long blink.

## Regression test
tests/engine/review-r3.test.ts, "positional only me items...": a blink through a wall is invalid, a blink in range works, and a long blink that ignores walls never lands in a sealed pocket.
