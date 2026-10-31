# Cut-away doesn't clear what blocks the player in doorways or adjacent enemies

- Severity: major
- Area: renderer (src/client/render/cutaway.ts, tiles.ts, index.ts updateCutaway)
- Status: fixed

## Evidence
- playtest-teen-12-fight.png: player in a doorway, the open door model and a full-height wall cover them.
- playtest-ship-12-fight.png: the enemy being fought is hidden behind an un-cut wall west of the player.
- playtest-western-51-exit-1.png: player on the exit tile hidden inside the transition model.
- playtest-western-12-fight.png: player in a doorway half covered.

Root causes: (1) the wedge was cast only from the player's tile, so walls between the camera and an
adjacent actor (beside or behind the player) were never lowered; (2) only walls and tall terrain
counted as occluders: door frames (lintel, posts, panel) and the transition model were never cut,
not even on the player's own tile.

## Fix
- `cutawayTiles` now unions: the player's full wedge plus the player's own tile; a narrow wedge
  (`around`, default 0.5) from each of the 8 neighbours (neighbour tile itself not lowered, so walls
  the player stands against stay up); and `focus` tiles (own tile + narrow wedge). `around: false`
  restores the old single wedge.
- `AreaView.isTall` includes door tiles and the exit tile when it has a transition model;
  `lowerTile` flattens the door group to a 0.14 stub and squashes the transition model (0.22).
  `propScaleY(i)` exposes this for tests.
- `Renderer.updateCutaway` passes visible, living actors adjacent to the player as `focus`, and keys
  the cache on them so the cut follows enemies stepping next to the player.

## Regression tests
- src/client/render/render.test.ts "clears walls between the camera and the 8 neighbours",
  "lowers the player tile and extra focus tiles when they are tall"
- src/client/render/tiles.test.ts "treats door frames and the transition model as tall and flattens them"
- e2e/render.spec.ts "cut-away clears doorways and adjacent actors in <world>" (screenshots
  docs/archive/progress/M1/cutaway-door-*.png)
