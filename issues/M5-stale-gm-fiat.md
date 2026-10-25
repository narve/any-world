# GM answers checked against the request snapshot but applied unchecked to the current state

- Severity: major (M5 review round 3, code)
- Area: src/client/session.ts (applyGm, act), src/client/gm-recheck.ts, src/client/game-controller.ts
- Status: fixed

## Evidence
tests/review/m5/r3-code-stale-gm.test.ts: `LlmGmDirector` accepts a player effect of hp -(hp-1) because it is non-lethal at `GmContext.state`. The answer can arrive up to 20 s later (or after HOLD_TURNS when held for an open choice); `GameSession.applyGm` passed it to engine `applyGmActions`, which runs none of the gm-checks, so with the player 6 hp lower the run was lost by GM fiat. `offer_choice` options were likewise checked when offered and run when chosen.

## Fix
- `recheckGmActions(world, state, actions)` (src/client/gm-recheck.ts): drops each action that fails `stateGoalProblem` against the CURRENT state, or whose engine dry run (cumulative, action by action) would end the run or harm / remove / transform / turn a goal actor in the area. World-only checks (goal writes, bounds, hook rules) are state-independent and stay in the GM runtime; engine refusals are left to the real application.
- `GameSession.applyGm` re-checks every answer (live, fallback, held, dialogue voice) before applying; `meta.trusted` skips it only for `controller.gmNow` (source 'debug': e2e set-ups and debugging).
- `GameSession.act` re-checks the picked option of an open `gm_offer` (`recheckOfferOption`) and runs the option without the actions that are no longer safe.

## Regression tests
tests/client/stale-gm.test.ts (the review repro, moved, plus: safe actions kept, cumulative damage, trusted path, offer option re-checked at choose time).
