# The offline demo generator's loading screen said "Asking the AI"

- Severity: minor
- Area: client (WorldGeneration progress text)
- Status: fixed
- Source: BUILD_LOG.md [M4/gate]; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M4.

## Evidence
With the offline demo preset no AI is involved, but the loading steps read "Asking the AI…" and "The AI answered".

## Fix
WorldGeneration takes `opts.offline`, and the request/received steps use gen.progress.offlineRequest /
offlineReceived. (M5 follow-up: the kept copy was still labelled "made by AI" in "Your worlds", see
issues/M5-offline-demo-labelled-ai.md.)

## Regression tests
tests/integration/m4-wiring.test.ts ('does not claim to ask an AI').
