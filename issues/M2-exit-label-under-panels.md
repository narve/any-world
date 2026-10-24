# Exit edge-arrow label overlaps the RULES panel and is truncated

- Severity: minor
- Area: client (src/client/map-overlay.ts, src/client/ui/ui.ts, src/client/game-controller.ts)
- Status: fixed (unit-tested; not re-shot in the dream world)

## Evidence
playtest-r1-fixture-dream-layer-choice.png: the label "Step into the point where eve…" and its arrow were drawn under the top-right Rules panel at about (950,105).

## Fix
- `GameUi.panelRects()` now also returns `hud`: the rectangles of every visible panel over the map (player card, top strip and objective, rules, hints and log, hotbar).
- `MapOverlay.setAvoid()` takes that list. `placeEdgeMarker()` (pure) keeps the arrow and its label clear of those panels plus a 6px pad. When they would overlap, it slides the arrow along the margin box in 8px steps until the arrow and label are both clear and the label fits on screen, then turns the arrow back toward the exit.
- `wrapLabel()` puts the label on up to two lines of about 24 characters, with an ellipsis only after that, instead of cutting it at 30 characters.

## Regression test
- tests/ui/m2-client-fixes.test.ts "exit label": wrapping, label side, sliding out from under a top-right rules panel (still on the margin box, still pointing at the exit), and no move when nothing is in the way.
