# Internal GM diagnostics ("GM add_rule skipped: …") were shown in the player's log

- Severity: major
- Area: engine (src/engine/gm.ts skip/gmSkip, src/engine/index.ts applyGmActions, types.ts)
- Status: fixed

## Evidence
playtest-r1-ui-ship-16-gm-rule-toast.png showed "GM add_rule skipped: over budget" in the log panel, and teen-gm-rule.png showed "…: unsupported". gm.ts `skip()` wrote them with `log(…, 'system')`, and the client renders system lines.

## Fix
Refused GM actions are no longer written to `state.log`. Each one emits a `{type:'gm_skipped', action, reason}` event, and `applyGmActions` also returns them as `StepResult.gmSkipped`. Malformed actions (exceptions) go the same way. The GM runtime or debug UI can show them; the player never sees them.

## Regression test
tests/engine/gm-rules.test.ts "refused GM actions stay out of the player log". tests/engine/game.test.ts now asserts on `gmSkipped` and checks that no "skipped"/"over budget" text is in the log.

## Note for sim owner
src/engine/sim/run.ts counted skips from `message` events of kind 'system'. Count `r.gmSkipped?.length` (or `gm_skipped` events) instead.
