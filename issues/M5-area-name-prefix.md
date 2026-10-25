# Area names repeat the area word and number in the log and the goal

- Severity: minor
- Area: content (content/worlds/*.json). The world-generation prompt half is owned by llm (src/llm/prompts/world*.ts).
- Status: fixed for every bundled world. The prompt rule is handed to the llm owner (see below).

## Evidence
The engine logs `log.area.enter` as "{area} {number}: {name}", and the guide and goal strip also add "{area} {n}". Several areas had the prefix baked into their names, so the log showed it twice:
- "Instans 1: 1. instans: Venterommet" (troll)
- "Dag 1: Mandag: Skolen" (russ)
- "Etasje 1: Tredje etasje: Felleskjøkkenet" (office-nb)

The goal read "Utforsk Mandag: Skolen og finn veien videre". The English worlds had the same pattern: "Floor 1: Third Floor: The Kitchen Commons", "Day 1: First Day: …", "Deck 1: Deck 7: …", "Layer 1: First Layer: …".

## Fix
Every bundled world is renamed so the name no longer carries a prefix. When the prefix held real information (a weekday or a tab), it moves to a trailing parenthesis.

| world | before → after |
|---|---|
| nb-troll-direktoratet | "1. instans: Venterommet" → "Venterommet"; also "Det uendelige arkivet", "Klagefristen", "Trehodes kontor" |
| nb-russetid-bussen | "Mandag: Skolen" → "Skolen (mandag)"; also "Russetreffet (onsdag)", "Inne i bassen (torsdag natt)", "Lageret på Alnabru (fredag)" |
| viking-lawspeaker-althing-nb | "Budene på Tingvellir", "Allmannagjå", "Inne i Hallbjørns minne", "Lovberget" |
| viking-lawspeaker-althing | "The Booths at Thingvellir", "Almannagja, the All-Men's Rift", "Inside Hallbjorn's Memory", "The Law Rock" |
| corporate-merger-kitchen(-nb) | "The Kitchen Commons" / "Felleskjøkkenet"; "The Integration Spreadsheet (Tab Four)" / "Integrasjonsregnearket (fane fire)" |
| detective-sugar-hotel | "The Grand Lobby", "The Pastry Kitchen (Below Stairs)" |
| fixture-dream | "The Loose Archipelago", "The Warm Underpainting", "The Grid Beneath Everything" |
| fixture-ship | "The Moss Cloisters" |
| fixture-teen | "Lowmoor High (Monday)", "The Achterbergs' Empty House (Wednesday)", "The Last Assembly (Friday)" |

Area names are not used as keys anywhere: recordings are keyed by area index, and saves keep the index. The renames therefore need no migration.

## Still open (llm owner)
The world-generation prompt should say: "areas[].name must not repeat vocabulary.area, an ordinal, a weekday or the area number; the game shows '{vocabulary.area} {n}: {name}' itself." It belongs in src/llm/prompts/world.ts or in the `AreaPlan.name` field doc in world-schema.ts. The content fixer does not own those files.

## Regression test
tests/content/m5-content-text.test.ts, "area names do not repeat vocabulary.area or the area number". It runs over every content/worlds/*.json and flags any of these:
- a "Prefix: " label
- a leading area word
- a leading digit
- a leading ordinal or weekday (en and nb)
