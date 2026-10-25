# GM and NPC prompts saw engine log lines in English in a Norwegian world

- Severity: minor
- Area: client (session.gmContext, controller pumpVoice, i18n/prompt-log.ts)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate] LLM prompts in the world language; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
The GM context and the NPC voice include the last log lines. In an nb world those were the English engine
sentences, nudging the model toward English replies.

## Fix
i18n/prompt-log.ts renders keyed engine log lines in world.meta.language for the GM context and the NPC voice.
GM/NPC lines and English worlds are unchanged.

## Regression tests
tests/integration/m4-wiring.test.ts ('renders keyed engine lines in bokmål for an nb world…').
