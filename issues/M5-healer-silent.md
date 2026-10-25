# Healer's 'Ask for help' heals silently and closes the dialogue

- Severity: minor (M5 review round 1)
- Area: src/client/session.ts (dialogueReply, reopenConversation)
- Status: fixed

## Evidence
Western, Preacher Weekes: Blood 38→45, dialogue closed, nothing in the log.

## Fix
After a service:heal option the session reopens the conversation (bookkeeping talk, its greeting is not logged again) and shows the NPC line '{npc} helps you: +{amount} {hp}.' (catalog key dlg.healed, dlg.helped when nothing was healed). The same line is appended to the log as a keyed 'good' line, so it is translated and kept in the history. The used-up service disappears from the options.

## Regression tests
tests/client/m5-client-fixes.test.ts 'a healer's "Ask for help" says what it did…'.
