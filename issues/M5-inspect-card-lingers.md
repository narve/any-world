# Long-press inspect card stays open after a tap on a button and covers the next sheet

- Severity: major (M5 review round 1)
- Area: src/client/ui/ui.ts, src/client/ui/components/common.ts (Tooltip.hidePinned), src/client/game-controller.ts (refreshTooltip)
- Status: fixed

## Evidence
iPhone 15 landscape: tap on 'Wait' left the player card open (it was re-shown by refreshTooltip after the turn) and it sat over the trade dialogue.

## Fix
A capture-phase pointerdown on the UI root hides a map card on any press outside it; render hides it whenever a blocking layer (dialogue, choice, level-up, trade, panel) is up; in touch mode the controller no longer re-shows the long-pressed card after an action.

## Regression tests
e2e/m5-client-fixes.spec.ts (iPhone 15 landscape: long-press → Wait closes it; long-press → dialogue opens → no card).
