# A short hostile behind a tall player model could not be tapped or attacked; the tap did nothing

- Severity: major (M5 mobile playtest, round 2)
- Area: renderer picking (src/client/render/index.ts `pick`), player model drawing
- Status: fixed (renderer). The remaining client-side suggestion is noted below.

## Evidence
The probe `probes-occluded-*` in tests/review/m5/mobile-playtest-r2.spec.ts was run on the mimic world,
iPhone 15 portrait. The player model is a big chair; the Clipboard Imp is 0.55 tall.
- The probe swept 651 screen points around the imp. Only 1 picked the imp's tile; 142 picked the player.
- `pick()` at the imp's tile centre and at its body returned the player's tile.
- A real tap changed nothing: no turn passed, no log line was added and no toast appeared.
  - Screenshot: pt-mobile-r2-probe-occluded-iphone15-portrait.png
  - Report: m5-mobile-pt-r2-probe-occluded-iphone15-portrait.json

## Root cause
`Renderer.pick` returned the first actor mesh along the ray. The player's model is in front of anything
standing right behind it, so it swallowed every tap aimed at that creature. The tap then meant "my own
tile", which does nothing.

## Fix
- `pick`: the player's own model is never the answer while something else is on the same ray.
  - If another actor's mesh is hit further along the ray, its tile is returned.
  - If not, and the ground point under the tap is a visible tile with a living non-player actor on it
    (only an antenna shows), that tile is returned.
  - Only otherwise does the player's tile come back.
- The player is drawn see-through (opacity `PLAYER_SEE_THROUGH` = 0.35, the same fade path as ghosting)
  while it hides an adjacent actor. `playerHidesNeighbour()` checks this: at least two of three rays from
  the camera to that actor's body hit the player model first. It is re-checked whenever the camera comes to
  rest after a turn, a rotation, a resize or an inset change. Ghosting (sneaking / invisible) combines with it
  (the lower opacity wins). Test accessor: `playerIsSeeThrough`.

## Not done here (client owner)
The suggested safety net in `GameController.onTap` is not added. That net would show a toast, or attack the
one occluded adjacent hostile, when a tap resolves to the player's own tile with nothing to do. The pick fix
removes the case that made the tap silent.

## Regression tests
- e2e/render-phone-panels.spec.ts "hostile behind a tall player model" (iPhone 15, mimic world, seed 4):
  - A hostile is moved onto the free neighbour drawn highest on screen.
  - `pick` at its tile centre and at its body returns its tile.
  - More than 20 of the swept points pick it (it was 1 of 651).
  - `playerIsSeeThrough` matches `playerHidesNeighbour()`.
  - A real touchscreen tap on it attacks: the turn advances.
  - Screenshot: test-results/shots/M5-render/phone-behind-player.png.
