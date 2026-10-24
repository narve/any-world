# GM action types that are Object.prototype keys made the area GM budget NaN (unlimited GM actions)

- Severity: critical
- Area: engine (src/engine/gm.ts applyGmList, leafRefError, leafCost/gmActionCost, offer_choice)
- Status: fixed (engine; client fixed by the M2 final gate: gm-director.ts isGmActionType/actionCost use Object.hasOwn, repros in tests/review/m2/round1.test.ts and round2.test.ts pass).

## Evidence
An offer_choice option holding `{type:'constructor'}` (or 'toString') passed `a.type in GM_ACTION_COST`, and leafCost added the inherited Function, so the cost was NaN. `NaN > budget` is false, so the offer applied and `gmBudget -= NaN` made the budget NaN. After that, 8 of 8 spawns landed. NaN saves as null, so after a reload every action counted as over budget.

## Fix
- `isGmActionType(type)` uses `Object.hasOwn(GM_ACTION_COST, type)` and replaces every `in` check. `typeCost()` returns 0 for anything else.
- Offer options are read through `offerLeaves()`, which keeps only well-formed leaf actions. An option containing an unknown action is dropped whole, like an option with a bad reference.
- applyGmList refuses any action whose cost, or the area budget, is not finite ("malformed cost"), so NaN can never reach the budget.

## Regression test
tests/engine/gm-rules.test.ts "GM budget: action types that are Object.prototype keys": through GameSession.applyGm, the spawn cap after a bad offer, top-level inherited keys refused, the bad option left out, the exact reservation, and a finite budget after a step.
