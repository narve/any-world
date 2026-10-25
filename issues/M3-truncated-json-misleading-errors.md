# A cut-off world reply was parsed as a nested fragment and gave 12 misleading "missing field" errors

- Severity: major
- Area: llm (src/llm/structured.ts extractJson), tools
- Status: fixed
- Source: BUILD_LOG.md [M3/integrator] Tools; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
When a model reply was truncated (output-token limit), `extractJson` picked the first balanced nested object
inside it and handed that fragment to zod. The repair turn then listed about 12 "missing field" errors for
fields the model had actually written, so the model was asked to fix the wrong thing.

## Fix
`extractJson` no longer accepts a nested fragment of a reply whose outer opener is unbalanced but clearly
starts JSON. It reports "the reply was cut off, reply more compactly" instead, and that is what the repair
turn sends. `tools/agent-provider.ts` also warns when a GM or dialogue reply has more helpful actions than the
help ceiling (the game would drop them silently).

## Regression tests
tests/llm/structured.test.ts (truncated reply → cut-off error, not a fragment).
