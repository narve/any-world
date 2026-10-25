# 'Ask what they know' closes the conversation; the answer repeats

- Severity: minor (M5 review round 1)
- Area: src/client/session.ts, src/client/view.ts (dialogueMap skip)
- Status: fixed

## Evidence
Viking, Gudrun: pressing 1 switched dialogue→game and the answer only appeared in the log; asking again appended the same line.

## Fix
The conversation is reopened and the answer becomes the NPC's line in the dialogue panel (player's question in the history; the LLM voice request for that turn carries on). The session remembers what each NPC has said; once every line has been heard, 'Ask what they know' is left out of the replies (`dialogueMap(pc, skip)`, used by both the view and dialogueReply).

## Regression tests
tests/client/m5-client-fixes.test.ts '"Ask what they know" keeps the dialogue open…'; e2e/m5-client-fixes.spec.ts (landscape dialogue).
