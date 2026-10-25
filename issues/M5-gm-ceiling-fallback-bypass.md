# Help ceiling bypassed by offline fallback answers (model failure or GM timeout)

- Severity: major
- Area: llm (src/llm/gm-runtime.ts)
- Status: fixed (llm side); the client may additionally wire `director.capped(offline)` as the GmRunner fallback

## Evidence
tests/review/m5/r1-gm-ceiling.test.ts 'a model failure after the area ceiling is used up…': with the ledger at HELPFUL_CEILING and a provider that fails with 503, LlmGmDirector.respond returned `this.fallback.respond(req)` without applyHelpCeiling or ledger.add (seed 1: set_flag + offer_choice(give_item) past the ceiling). The same happened when the GmRunner hit LIVE_GM_TIMEOUT_MS (30 s) and its own OfflineGmDirector answered.

## Fix
- `CappedGmDirector(inner, ledger)`: runs the inner director's answer through keepValidActions (goal protection + engine dry run), then applyHelpCeiling against the shared ledger, and charges the ledger. LlmGmDirector wraps its fallback in it, so every fallback answer is capped and counted. `LlmGmDirector.capped(d)` gives the same wrapper for any other director (for example the runner's fallback).
- LlmGmDirector has a `deadlineMs` option (default `DEFAULT_GM_DEADLINE_MS` = 20 s, below the client's 30 s live runner timeout). When the model is still busy at the deadline, the director aborts it and answers through its capped fallback itself, so the runner's uncapped fallback no longer answers a slow live GM.
- applyHelpCeiling now receives the state, so classification can use it (see M5-gm-help-classification).

## Known limit
The ledger is still in memory: a page reload starts the area's ceiling again. The client creates the director per run; persisting the ledger would need a saved-run field (client/shell).

## Regression test
tests/llm/gm-ceiling.test.ts: the original repro; 'past its deadline the director answers through the capped fallback' (a provider that hangs until aborted, deadlineMs 20, a fallback offering three grant_xp: only the ceiling's worth survive and the ledger is charged); 'a CappedGmDirector sharing the ledger caps the runner's own fallback'.
