# The objective line is cut off with an ellipsis, hiding the 'where to go' hint

- Severity: minor
- Area: client (src/client/view.ts, src/client/ui/ui.ts, src/client/ui/viewmodel.ts, src/client/styles/ui.css)
- Status: fixed

## Evidence
Dream: "... — find the way o…" (playtest-r1-fixture-dream-play-0060.png). Teen: "... — find the way on from Wednesday: The Achterberg…" (playtest-r1-fixture-teen-area1-arrive.png). The cut-off part is the useful guidance.

## Fix
- `objectiveParts()` splits the objective into `goal` and `hint` ("Find the way on from X", "The way on (…) is marked on the map", "Press > to …"). `objectiveOf()` still returns the joined single line.
- `GameView.objective` is now the goal only. A new `GameView.objectiveHint` holds the hint.
- The objective element has two lines. The goal is one line and may end in an ellipsis. The hint has its own accent-coloured line that wraps and is never truncated. The tooltip shows the full text.

## Regression test
- tests/client/m2-client-fixes.test.ts "objective line": the split, the view-model fields, the joined form, and the "Press >" hint.
- e2e/client-m2-fixes.spec.ts (teen): `.aw-objective-hint` is visible and not clipped. Screenshot: docs/progress/M2/client-fix-objective.png.
