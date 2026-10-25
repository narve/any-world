# Zoom keys inverted: '+' zoomed out, '-' zoomed in

- Severity: major (M5 review round 1)
- Area: src/client/session.ts (intent 'zoom'), src/client/ui/viewmodel.ts
- Status: fixed

## Evidence
Keyboard '+' → {zoom, delta: 1}; session forwarded it unchanged to renderer.zoom, whose contract is delta > 0 zooms OUT. distTarget 17.4 → 27.3 after '+'.

## Fix
The UI intent keeps '+1 = zoom in' (documented on UiIntent); GameSession.intent flips it into the renderer contract (`camera.zoom = delta > 0 ? -1 : 1`). Wheel and pinch were already right.

## Regression tests
tests/client/m5-client-fixes.test.ts 'keyboard zoom'; e2e/m5-client-fixes.spec.ts '"+" zooms in and "-" zooms out'.
