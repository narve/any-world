# GM offer_choice during a pending perk choice soft-locks the keyboard

- Severity: critical
- Area: client (src/client/ui/input.ts, src/client/view.ts, src/client/ui/ui.ts)
- Status: fixed

## Evidence
The engine resolves `player.pendingPerkChoice` before any `pendingChoice` (src/engine/actions.ts: `choose a perk first` rejects `choose_option`). The UI did the opposite: `computeLayer` returned `'choice'` before `'levelup'`, and `renderGame` showed the ChoiceModal (later in the DOM, with backdrop + focus trap) above the LevelUpModal. Because GM hooks are async, a kill can level the player up while a GM response is in flight; `applyGmActions` then opens an `offer_choice` on top of the pending perk (also reproducible in a single action list: `grant_xp 200` + `offer_choice`). In the `choice` layer Esc does nothing and digits/Enter only send `choose_option`, which the engine rejects, so the game cannot continue — and an autosave restores the lock after reload.

## Fix
The UI now follows the engine's order:
- `computeLayer` checks `levelUp` before `choice`.
- `gameView` returns `choice`, `dialogue` and `trade` as `null` while a level-up is pending, so they cannot be shown or receive input; they reappear once the perks are picked.
- `renderGame` additionally hides the choice/dialogue/trade panels whenever `g.levelUp` is set (defence for view models built elsewhere, e.g. the demo).

The engine's `offer_choice` is left as is: the offer stays queued in `pendingChoice` and is handled right after the perk choice, which is the engine's existing priority — skipping it would lose the GM's offer.

## Regression test
tests/client/choice-perk-priority.test.ts (fixture-western: grant_xp 200 + offer_choice -> layer is `levelup`, choice hidden, perks accepted, then the offer becomes reachable and `choose_option` resolves it). tests/ui/input.test.ts priority order updated.
