# Nothing tells the player when the WebGL context is lost

- Severity: minor (M5 review round 1)
- Area: src/client/game-controller.ts (onGraphicsContext), src/client/ui/ui.ts (setGraphicsLost), ui.css
- Status: fixed

## Evidence
loseContext() left the map black, no message, and a tap on Wait still passed a turn.

## Fix
The controller subscribes to renderer.onContextChange. While lost: travel stops, a notice ('Graphics paused…', gfx.lost/gfx.lostHint, en+nb) covers the run, the UI is blocking (no map input) and keyboard commands are ignored; after 5 s a 'Reload the game' button appears (the run is autosaved). On restore the notice goes and the view re-renders.

## Regression tests
e2e/m5-client-fixes.spec.ts 'a lost WebGL context shows a notice…' (no turn while lost, reload offer, play resumes after restoreContext).
