# iPad Mini: the goal overlapped the HUD at 1024 px and the hotbar ran off a 768 px screen

- Severity: major
- Area: client UI CSS (tablet layout)
- Status: fixed
- Source: BUILD_LOG.md [M4/mobile] Later fixes; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
Device runs on iPad Mini: in landscape (1024 px) the top-centre goal column overlapped the HUD; in portrait the
hotbar ran off the 768 px screen.

## Fix
The top-centre column is held to its grid cell; in portrait the panel buttons wrap into a row above 46 px slots;
landscape toasts sit in the map column under the strip.

## Regression tests
e2e/mobile.spec.ts, tablet layout tests (iPad Mini portrait and landscape).
