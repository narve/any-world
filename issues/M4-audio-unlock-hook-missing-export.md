# The mobile audio-unlock boot hook loaded the audio chunk on the start screen and found no `unlock` export

- Severity: minor
- Area: client (main.ts boot, audio bridge)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate] Audio; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
`installAudioUnlock` in main.ts fetched the lazy audio chunk on the start screen to install an iOS unlock
handler, but the module has no `unlock` export, so the hook did nothing except load the chunk early.

## Fix
The boot hook was removed. AudioBridge installs the module's own `installUnlock` when the module loads with the
first run. ui/audio-unlock.ts stays with its tests.

## Regression tests
tests/ui/mobile-input.test.ts (audio-unlock); tests/integration/m4-wiring.test.ts.
