# Start screen keeps its old scroll position after "New world"

- Severity: minor
- Area: client UI (src/client/ui/components/screens.ts StartScreen)
- Status: fixed
- Source: M5 desktop playtest round 1 (tests/review/m5/pt-desktop-r1.spec.ts)

## Evidence
After a run, "New world" landed mid-page on the demo list with the prompt box off screen
(docs/archive/progress/M5/pt-desktop-r1-start-again.png). `main.aw-screen.aw-start` had scrollTop 1062, the position
where the demo card was clicked before the first run. pt-desktop-r1.spec.ts: `expect.soft(scrollTop).toBe(0)`,
received 1062.

## Root cause
The start screen is one element that is hidden and shown again (ui.ts toggles `hidden`). A hidden element keeps
its scrollTop, and nothing reset it. The prompt got focus with `preventScroll: true`, so focusing did not
scroll it into view either.

## Fix
StartScreen watches its own `hidden` attribute (MutationObserver) and calls `resetScroll()` whenever it is shown
again. That sets scrollTop to 0 on the screen and on its inner columns (they scroll on their own on some
layouts). The existing autofocus still moves focus to the prompt box, which is now in view. The fix lives in
screens.ts, so ui.ts needs no change.

## Regression tests
e2e/modes.spec.ts '"New world" after a run opens the start screen at the top, prompt box in view': scrolls to the
last demo card, plays it, ends the run, clicks "New world", then expects scrollTop 0 and the prompt in the
viewport and focused.
