# Unknown items: effect lines reveal produced items, identical fallback appearances

- Severity: minor
- Area: engine (src/engine/describe.ts effect lines, src/engine/knowledge.ts initKnowledge)
- Status: fixed

## Evidence
- A known item with a `spawn_item` effect showed "Produces Murky Draught" while the produced item was still unknown (tests/review/engine-round2.test.ts).
- With the `allConsumablesUnknown` switch and no `unknownAppearances` pool, every unknown item of the same kind showed the same label, "Unfamiliar flask" (tests/review/engine-round3.test.ts).

## Fix
The effect line uses `displayItemName`. Fallback appearances are now unique per run: they try adjectives ("strange flask", "curious flask", ...) and then numbers, and they avoid labels already taken from the pools.
