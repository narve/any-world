# Arc Weld (direction-targeted reusable) starts its cursor on the player; Enter fails with 'Pick a direction'

- Severity: minor
- Area: client (src/client/session.ts, src/client/view.ts, src/client/map-overlay.ts, src/client/game-controller.ts, src/client/ui/ui.ts)
- Status: fixed

## Evidence
Pressing `2` opened targeting with the hint "Enter confirm" (playtest-r1-ui-ship-04-reusable.png). The cursor sat on the player's tile and showed the player's own tooltip. Enter then produced the toast "Pick a direction ×2" and no turn passed (playtest-r1-ui-ship-05-reusable-cooldown.png, `reusable-weld` turn unchanged). No direction arrows were drawn.

## Fix
- `aimsDirection(def)` (view.ts) is true for aimed `ray` / `cone` items. The slot view carries `aimsDirection`.
- `GameSession.beginTarget`: for these items the cursor never starts on the player. It starts on the engine's auto target if that is not the player. Otherwise it goes one tile toward the nearest visible hostile. Otherwise it goes one tile in `facing`, the last direction the player moved (default south).
- While aiming a direction, arrow keys choose one of the eight tiles around the player (`moveCursor`), so the cursor never drifts back onto the player. Clicking a tile still aims at it.
- `GameSession.aim()` gives `{from, at}`. `MapOverlay.setAim` draws eight small arrows around the player and lights the chosen one (`.ov-dirs`).
- Mode banner: "Aim <item> — arrow keys pick a direction (or click) · Enter confirm · Esc cancel".

## Regression test
- tests/client/m2-client-fixes.test.ts "direction-aimed items": the cursor starts in the facing direction and Enter fires (the turn advances and targeting closes). Arrows pick and hold a direction. The slot view flags the item.
- e2e/client-m2-fixes.spec.ts (ship): banner text, direction marks visible, Enter spends a turn. Screenshot: docs/progress/M2/client-fix-weld-direction.png.
