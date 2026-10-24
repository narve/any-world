# Some perk cards have no effect chip, unlike the others

- Severity: minor
- Area: content (perk descriptions); the chip derivation is client (src/client/view.ts perkLines)
- Status: fixed in content. A client-side chip derived from triggers is still recommended.

## Evidence
Ship "Spore-Lungs" and teen "Power Saver Mode" show only flavour text on the level-up card, while other cards show "+2 Reflex", "Gain: Overclock" and so on (playtest-r1-fixture-ship-layer-levelup.png, playtest-r1-ui-teen-levelup.png).

## Root cause
`perkLines()` builds chips only from `modifiers` and `grantItems`. Perks that work purely through `triggers` get no chip, and some of their descriptions were pure flavour ("Sometimes it just rolls off.").

## Fix
Every trigger-only perk in the four fixtures now ends its description with a short mechanical summary:
- ship: Scavenger "30% chance that a kill drops an O2 canister."; Spore-Lungs "40% chance to cure Spored whenever you are hurt."
- teen: Unbothered "25% chance to shake off every harmful condition whenever you are hurt."; Last Word "Recover 3 Composure every time you win a confrontation."; Power Saver Mode "+6 Battery on entering a new day."
- western: Blood from a Stone "+1 Rounds per kill."; Last Stand "Dropping below 30% Blood gives you Steady Hand for 10 turns."
- dream: Sfumato "30% chance when hurt to turn Glazed Through for 2 turns."
- Shallow Breather, Keep a Wet Edge and Persistence of Vision already stated their numbers.

Suggestion for the client owner: derive chips from triggers in `perkLines`, e.g. "On hurt: 40% cure Spored" or "+6 Battery per area", so LLM-generated worlds get them too.

## Regression test
tests/content/fixtures-m2.test.ts, "perks without stat/item chips spell out their mechanics". Every perk with no modifiers or grantItems must have a number in its description.
