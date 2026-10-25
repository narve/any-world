# Client world generation times out at 300 s total although one reply may take up to 600 s

- Severity: major
- Area: llm (src/llm/generate.ts)
- Status: fixed

## Evidence
tests/review/m5/r2-code-gen-timeout.test.ts: WorldGeneration built as main.ts builds it (no timeoutMs) with a provider answering a valid world after 360 s (fake timers) ended `{ok:false, kind:'timeout'}`. generateWorld defaulted timeoutMs to 300 000 for all provider calls together, while one call may take 600 s per attempt (DEFAULT_TIMEOUT_MS) and 660 s through the backend (DEFAULT_BACKEND_TIMEOUT_MS).

## Fix
The default total deadline is now derived from the pipeline: `(1 + repairs) x (1 + balanceFeedback)` possible provider calls x `GENERATION_CALL_BUDGET_MS` (= DEFAULT_BACKEND_TIMEOUT_MS, the longest per-call wait of any transport). Per-attempt timeouts in the HTTP layer and the caller's signal (Cancel) still bound each call; an explicit `timeoutMs` still wins (0 = no total limit). No client change needed.

## Regression test
tests/llm/generate-deadline.test.ts: the review repro (6-minute reply through the client WorldGeneration), a repair turn after a 5-minute first reply, and an explicit timeoutMs still ending as 'timeout'.
