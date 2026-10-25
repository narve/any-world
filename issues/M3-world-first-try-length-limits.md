# Half of the agent-written worlds failed first validation on text length limits

- Severity: minor
- Area: llm prompts (src/llm/prompts/world.ts)
- Status: fixed
- Source: BUILD_LOG.md [M3/gate] Prompt fixes; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
First-try validity of the 14 agent-authored worlds was 7/14; 6 of the 7 failures were length limits (an item
name > 40 chars, a tagline > 140, a verb > 30) that the prompt mentioned in scattered places. Others used an
undocumented shape ("ico") or a placeholder item id.

## Fix
The M3 gate consolidated the length limits into one list in the world prompt, added a non-abstract shape example
and the other feedback themes in docs/progress/M3.md. The repair turn still fixes the rest.

## Regression tests
tests/llm/prompts.test.ts (schema doc mentions every key and enum; field notes name real fields).
