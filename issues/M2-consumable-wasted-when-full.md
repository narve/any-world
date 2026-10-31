# A consumable whose resource is already full is spent with no warning

- Severity: minor
- Area: client (src/client/session.ts, src/client/view.ts)
- Status: fixed

## Evidence
At the ship start O2 is 120/120. Pressing `3` consumed an O2 Canister (count 2→1, log "uses O2 Canister.") with no confirmation (playtest-r1-ui.json `consumed-o2`, playtest-r1-ui-ship-01-consumed.png).

## Fix
- `wastedRestore(world, def, sheet, statuses)` (view.ts) returns the names of the full vitals ("O2", "Health and O2") when using the item now would do nothing. That is the case when its effects are only heals or positive resource gains (plus messages, or cures for conditions the user does not have), aimed at the user, with no condition, and every vital it restores is already at max. Otherwise it returns null. Items with any other effect, such as a status, are never treated as wasted.
- `GameSession.uiAction` (use, no target): if the item is identified (`knowledge === 'clear'`, so nothing leaks about unknown items) and would be wasted, the first press only shows a toast: "O2 is already full — use O2 Canister anyway? (press again)". A second press of the same item uses it. Any action in between (`act`) re-arms the warning.
- Not covered: the sim bot wasting canisters (engine/sim owner).

## Regression test
- tests/client/m2-client-fixes.test.ts "consumables whose vitals are already full": warn and then use, re-arm after another action, no warning when not full or when the item cures a condition the player has, and a status side effect is never "wasted".
- e2e/client-m2-fixes.spec.ts (ship): the toast is visible and the count is unchanged after the first press, then drops after the second. Screenshot: docs/archive/progress/M2/client-fix-o2-full-warning.png.
