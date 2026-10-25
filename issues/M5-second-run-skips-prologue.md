# A second run started from the end screen skips its prologue; how-to-play only after the first move

- Severity: major (M5 review round 1)
- Area: src/client/ui/components/narration.ts, src/client/ui/ui.ts
- Status: fixed

## Evidence
Western played to the end → New world → Lowmoor opened at turn 0 on layer 'game' with no prologue (pt-desktop-r1-teen-01.png). NarrationCard kept a `dismissed` Set for the life of the UI; session narration ids ('intro', `area-<i>-<seq>`) repeat from run to run, so the new run's 'intro' counted as dismissed and session.narration stayed set, hiding the onboarding card until the first action.

## Fix
`NarrationCard.reset()` clears the dismissed ids and hides the card; `UiRoot.render` calls it whenever the screen leaves 'game' (end, start, loading), so every mounted run starts clean. The start screen also scrolls back to the top when it is shown again.

## Regression tests
e2e/m5-client-fixes.spec.ts 'a second world started from the end screen…' (prologue shows, Lowmoor text, onboarding card with verb keys after it, start screen scrollTop 0).
