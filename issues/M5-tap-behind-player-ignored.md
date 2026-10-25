# On a phone, a tap on the floor tile right behind the player model did nothing

- Severity: major (M5 mobile playtest, round 3)
- Area: renderer picking (src/client/render/index.ts `Renderer.pick`)
- Status: fixed (renderer)

## Evidence
The probe `behind-player-*` in tests/review/m5/mobile-probes-r3.spec.ts picks the free floor neighbour
drawn highest on screen, waits for the camera to rest, and taps the centre of that tile.
- On iPhone 15 portrait (detective-sugar-hotel, me 39,21, target 39,20), `pick(centre)` returned the
  player's tile, while `screenToTile(centre)` returned the target. The turn stayed at 0 and the player did
  not move.
- iPhone 15 landscape (fantasy-retired-mimic, me 39,5, target 39,4) gave the same result.
- Pixel 7 portrait walked, because the tile showed past the model there.
- In the deep run (m5-mobile-pt-r3-iphone15-portrait.json, turn 7), a tap north of the player showed
  "No known way there".
- Reports: tests/review/m5/reports/m5-mobile-pt-r3-probe-behind-iphone15-{portrait,landscape}.json
- Screenshot: docs/progress/M5/pt-mobile-r3-probe-behind-iphone15-portrait-empty-tap.png. The tile centre
  sits on the player's head.

## Root cause
The fix for issues/M5-hostile-behind-player-untappable.md stopped the player's model from hiding an actor
behind it. Two cases were still wrong:
- When the ray hit only the player model, `pick` returned the ground tile only if a visible non-player
  actor stood on it. Otherwise it returned the player's own tile.
- An empty floor tile behind a tall model therefore resolved to "my own tile". That tap meant nothing
  (no move, or a misleading toast).

## Fix
`pick` now returns the ground tile under the point when the ray hits only the player's own model:
`screenToTile(x, y) ?? playerTile`.
- A tap on the player's model counts as "my tile" only when the ground point really is the player's tile
  (its feet or lower body), or when the ground point is off the map.
- Hits on other actors' models are unchanged. They still win over the player's model.
- The helper `visibleActorAt` is no longer used and has been removed.

## Regression tests
e2e/render-phone-panels.spec.ts "empty tile behind the player model (...)" runs on three devices:
- iPhone 15 portrait, detective-sugar-hotel, seed 5
- iPhone 15 landscape, fantasy-retired-mimic, seed 4
- Pixel 7 portrait, nb-troll-direktoratet, seed 6

Each run takes the free floor neighbour drawn highest on screen and checks the following:
- `pick` at its centre returns that tile.
- `pick` at the player's own tile centre still returns the player's tile.
- A real touchscreen tap moves the player there and advances the turn.

Screenshots: test-results/shots/M5-render/phone-behind-player-empty-*.png.
The existing test "hostile behind a tall player model" still covers the case with an actor behind the model.

## Not done here (client owner)
The suggestion to make the controller treat a tap on its own tile as Wait, or to ignore it quietly instead
of showing "No known way there", belongs to src/client/game-controller.ts.
