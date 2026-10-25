# Low-HP "press N" hint points at an empty charged item; pressing it says "Works just by being carried"

- Severity: major (M5 review round 2, desktop playtest)
- Area: src/client/view.ts (danger hint), src/client/ui/slots.ts (activateSlot, slotExplanation)
- Status: fixed

## Evidence
Rain Broker, stretch 2, Blood 11/45: the HUD said "Blood low · press 3" and slot 3 glowed, but slot 3 was the Army Canteen at 0/3 charges; Sarsaparilla (heals 6) sat usable in slot 5. Pressing 3 took no turn and opened the passive tip "Works just by being carried — nothing to press." (docs/progress/M5/pt-desktop-r2-western2-hint-empty.png, -press3-empty.png, -dyn-target.png).

## Cause
The danger-hint loop picked the first quick slot whose `restores` matched and skipped only items on cooldown. The engine marks a 0-charge item `usable:false`, so `activateSlot` fell through to `{kind:'explain'}` and the tip used `slot.explain.passive`.

## Fix
- `readyToUse(sv)` (view.ts): usable, not cooling down, charges left. The hint uses it, so it falls through to the next item that restores the same vital (or shows no key at all).
- `activateSlot` returns `{kind:'blocked', reason: t('slot.noCharges')}` ("Army Canteen is empty (0/3)." / "… er tom (0/3).") for a charged item that is out of charges; `slotExplanation` says the same instead of the passive line.

## Regression tests
tests/client/m5-client-r2.test.ts "low-HP press N hint and an empty charged item" (moved from tests/review/m5/pt-desktop-r2.test.ts).
