# Repeated invalid-action toasts pile up over the player and never say why

- Severity: major
- Area: client (src/client/ui/ui.ts toasts, src/client/ui/toasts.ts, src/client/invalid.ts, src/client/session.ts)
- Status: fixed

## Evidence
While Lassoed (rooted, 1 turn left), each move key added another identical "you cannot move" toast. Twelve of them stacked down the middle of the screen over the character. Nothing told the player that waiting ends the status, so the rooted turn never ticked down. "too afraid to fight" (Rattled) behaved the same and also hard-codes "fight". Screenshot: docs/archive/progress/M1/playtest-western-assist-r3-20-stall.png. The bot stats in run-western-assist(2).out repeat the same strings dozens of times.

## Fix
- Toasts: a DOM-free `ToastStack` model (src/client/ui/toasts.ts) backs `GameUi.toast`.
  - An identical toast (same text and tone) merges into the visible one: it shows a count ("×3"), moves to the newest position, restarts its timer and plays a short pulse.
  - At most three toasts are visible; the oldest goes first.
- Reasons: `explainInvalid` (src/client/invalid.ts) rewrites the engine's terse refusals in `GameSession.act`, using the world's status names, the turns left and the world's conflict verb:
  - rooted: `Lassoed (1 turn left): you cannot move — wait (.) to let it pass.`
  - afraid: `Rattled (2 turns left): "Draw on" is out of the question — step away, or wait (.) to let it pass.`
  - Other reasons pass through, capitalised. A reason that already names the status is left alone, so a future, more specific engine string is never overwritten.
- Detection is keyed on the player's status flags (`rooted`, `afraid`) and the action type, not only on the exact engine string. The engine's own strings (src/engine/actions.ts) were left to the engine owner.

## Regression test
- tests/ui/toasts.test.ts covers merging, the count label, tone separation, the cap of 3, timer restart on repeat, revival while fading, and `clear()`.
- tests/client/invalid-reasons.test.ts covers rooted (western "Lassoed", teen "Written Up"), afraid (with the world's conflict verb and no "fight"), and checks that waiting as advised frees the player and that other reasons pass through.
