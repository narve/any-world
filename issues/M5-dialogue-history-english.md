# Dialogue transcript shows the player's reply in English in the bokmål UI

- Severity: major (M5 review round 2)
- Area: src/client/session.ts
- Status: fixed

## Evidence
docs/progress/M5/nb-r2-z-althing-informant-2.png: the transcript shows "Ask what they know" while the reply button reads "Spør hva de vet". Every nb world, every built-in option.

## Cause
`GameSession.act` pushed the raw engine label (`prevChoice.options[i].label`, English, src/engine/npc.ts) into the history; the reopened-conversation path (healer / informant answers) passed `opt.label` as the LLM voice turn's `playerLine` too.

## Fix
Both use `dialogueOptionLabel(option)` (src/client/i18n/engine-text.ts), the same text the reply buttons show. The NPC voice request therefore gets the line the player actually picked.

## Regression tests
tests/client/m5-client-r2.test.ts "dialogue transcript in the UI language" (nb UI, informant: history entry equals the bokmål button label and is not any English engine label).
