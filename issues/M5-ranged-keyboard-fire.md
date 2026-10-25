# Ranged weapons cannot be fired at range with the keyboard; the gun's slot tip says "bump into"

- Severity: major (M5 review round 2, desktop playtest)
- Area: src/client/ui/slots.ts, src/client/session.ts, src/client/guide.ts, src/client/ui/input.ts (help)
- Status: fixed

## Evidence
Rain Broker: onboarding said "click or tap someone hostile in sight"; there was no keyboard way. Pressing 1 (the equipped Postal Peacemaker, range 5) showed "Equipped as your Draw on — bump into anyone hostile (red ring) to use it." (pt-desktop-r2-western3-press1.png). Look mode + Enter only described the deputy. Range-3 kiters out-ranged a keyboard player.

## Fix
- `SlotItemView.range` (weapon reach, set when > 1).
- Pressing the equipped ranged weapon's quick-slot key now returns `begin_target`: the session enters target mode with the cursor on the nearest hostile the engine accepts an `attack` on (`GameSession.firingWeapon()`). Arrows move the aim; Enter, a click, or the same digit again fires (`{type:'attack', targetId}`). Confirming on a tile with nobody to shoot keeps aiming open with a toast (`toast.noRangedTarget`), no turn passes. The target banner ("Choose a target for {item}…") already explains the keys.
- Slot tip: `slot.explain.weaponRanged` "Equipped as your {conflict} — it reaches {range} tiles. Click someone hostile in sight, or press {key} to aim … and Enter to fire." (`…NoKey` variant for a weapon kept in the backpack).
- Onboarding: `onboard.conflict.rangedKey` names the key (with the entry's key chip); help lists "1 – 8, Enter: aim the equipped ranged weapon, Enter fires" (`help.fire`). en + nb.

## Regression tests
tests/client/m5-client-r2.test.ts "ranged weapon with the keyboard" (tip, activateSlot, session aim + fire, empty-tile confirm, onboarding/help).
