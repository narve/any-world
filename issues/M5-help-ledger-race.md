# Shared help ledger read before the model await: a GM moment and an NPC voice turn in flight together each spend the full ceiling

- Severity: major
- Area: llm (src/llm/gm-runtime.ts)
- Status: fixed

## Evidence
tests/review/m5/r2-code-ledger-race.test.ts: LlmGmDirector.respond and LlmDialogue.turn (sharing director.ledger) both read `helpfulUsed = ledger.get(state)` before `completeStructured` and capped with `ceiling - helpfulUsed` after it returned. With both requests answered after a gate opened (two grant_xp each) the player got 4 helpful actions on normal (HELPFUL_CEILING.normal = 2).

## Fix
Both paths re-read the ledger right before applyHelpCeiling (`ceiling - this.ledger.get(state)`), as capResponse already did. The re-read and the ledger.add run in one synchronous step, so whichever answer arrives second sees what the first charged. `helpfulUsed` before the await is still used for the prompt.

## Regression test
tests/llm/gm-ledger-race.test.ts (the review repro, now asserting exactly the ceiling is spent and charged).
