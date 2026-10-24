# A conditional terrain interaction is used up when its condition fails (locked chest can never be opened later)

- Severity: major
- Area: engine (src/engine/actions.ts doInteract)
- Status: fixed

## Evidence
`doInteract` set `t.interacted = true` before `runAction`, even when the condition failed. A Strongbox with `has_item key`, tried once without the key, answered "Strongbox: nothing more to find" after the key was found. If it held a goal or lock item, the run was soft-locked.

## Fix
The tile is marked used only after the action ran (`res.ok && !res.conditionFailed`). A pure luck condition (`condition.type === 'chance'`) is the exception: the fixture terrains (dry-well, lockers, vending-machine, cryo-pod) intend one roll per tile, so a failed roll still uses the tile up. A failed targeting (`!res.ok`) never uses the tile up. The mark goes on the used terrain where it now is: if the action covered it with temporary terrain, the mark goes in `terrainUnder.interacted`. A permanent replacement starts fresh.

## Regression test
tests/engine/review-r3.test.ts, "terrain interactions": the strongbox opens once the key is held and is used up afterwards; a failed `chance` roll still uses the tile up.
