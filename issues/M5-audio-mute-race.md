# Audio: mute right after unmute left the AudioContext running while muted

- Severity: minor (review M5 round 1)
- Area: src/client/audio/index.ts (sync)
- Status: fixed

## Evidence
tests/review/m5/r1-audio-mute-race.test.ts used a context whose `state` changes only when
resume()/suspend() settle, as in browsers. unlock (muted) → suspended, then `mute(false); mute(true)`
ended with `ctx.state === 'running'` and `muted === true`: the second sync() saw 'suspended' (resume
still pending) and skipped suspend(); the first returned early after resume(). Ambience oscillators
kept running into a zero gain, breaking "muting suspends it too, so a muted game costs no CPU".
The mirror race (`mute(true); mute(false)` while running) left the context suspended while unmuted.

## Fix
sync() is now serialised: one pass (`syncOnce`) runs at a time; a call made while a pass is in flight
marks it dirty and the pass loops with the latest muted/hidden/ambience flags. Every caller's promise
resolves after the final pass, so the context always ends in the state the last call asked for.
Visibility changes during a pending resume are covered by the same path.

## Regression tests
tests/audio/mute-race.test.ts (moved from tests/review/m5): unmute→mute ends suspended, mute→unmute
ends running, seven rapid toggles follow the last one. Both race tests fail without the fix.
