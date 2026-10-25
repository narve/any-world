# Settings and the music panel could not be opened during a run

- Severity: major
- Area: client UI (help overlay, settings dialog)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate] Music panel mounted; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
The music panel (SoundCloud, mute, volume) was built but never mounted, and there was no way to open settings
once a run had started.

## Fix
AudioBridge.mountPanel(host) keeps one music panel per run and moves it between hosts; the settings dialog shows
it in its audio section during a run; the help overlay got a "Settings & music" button (help.settings).

## Regression tests
tests/integration/music-panel-mount.test.ts; e2e/m4-gate.spec.ts.
