# Temporary terrain permanently erases the terrain it was spawned over

- Severity: major
- Area: engine (src/engine/effects.ts spawnTerrain, src/engine/turn.ts endRound terrain expiry)
- Status: fixed

## Evidence
`spawnTerrain` overwrote `t.terrain` without recording the old terrain, and expiry did `delete t.terrain`. Two turns of glue over a chest left the tile with no terrain at all. Chests, pillars, or any interactable or goal terrain hit by a temporary area effect disappeared for good.

## Fix
- `Tile.terrainUnder?: { terrain; interacted? }` is a new optional field. Temporary terrain records the permanent terrain it covers, including its used flag. A temporary layer over another temporary layer keeps the original record.
- On expiry, `endRound` restores the covered terrain and its interacted flag. A covered blocking terrain (a chest, a pillar) waits while an actor or item is on the tile, so nobody is ever left inside a wall. The tile is free to walk while it is covered.
- Permanent terrain still replaces the tile for good. It clears `terrainUnder` and starts unused, unless it is the same terrain that was already used. The rollback when an effect would wall off the exit restores all four fields.

## Regression test
tests/engine/review-r3.test.ts, "temporary terrain": the chest comes back; layered temporary terrain restores the original and keeps a used chest used; a covered pillar waits for the actor on it to leave.
