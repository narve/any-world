# Pressing 1 on the equipped Thesaurus opened the backpack — it looked like a bug

- Severity: major (user playtest of Lowmoor, PLAN backlog "Clearer controls & goals")
- Area: client UI (src/client/ui/slots.ts activateSlot, src/client/ui/ui.ts)
- Status: fixed

## Evidence
`activateSlot` returned `{kind:'inspect'}` for anything that does nothing when activated (an equipped
weapon, armour, a passive charm). The UI answered with `openBackpackAt(slot)`, so pressing 1 on the
starting Thesaurus (badge "E") popped open the full backpack. Nothing said what the E meant or how the
weapon is used.

## Fix
`activateSlot` now returns `{kind:'explain'}` for those items. The UI shows a small tip anchored to the
quick slot (`SlotTip`, src/client/ui/components/guide.ts) built by `slotExplanation(item, vocabulary)`:
"Equipped as your Comeback — bump into anyone hostile (red ring) to use it", the known effect lines,
and "The E badge means equipped…", with a Details button that opens the backpack on purpose. A tap
elsewhere, Esc or any action closes it; on touch, a tap no longer also opens the hover card. The E badge
has its own tooltip, and the help overlay has a "Slot badges" legend. Long-press on a slot opens its
actions on touch (same as right-click).

## Regression tests
tests/ui/guide-ui.test.ts (explain result, explanation lines per item kind), tests/ui/slots.test.ts,
e2e/client-m3.spec.ts (key "1" and a tap on slot 1 at 1280×800 and 390×844: tip visible, backpack
hidden; Details opens it).
