# GM 'trade' action hands out any item (goal and lock items included) for free

- Severity: major
- Area: llm (src/llm/gm-checks.ts); engine follow-up optional
- Status: fixed (llm side)

## Evidence
tests/review/m5/r2-code-gm-trade.test.ts: fixture-teen area 0, `{type:'trade', actorId:<any living actor>, items:[{item:'speech-notebook', price:0}]}` got no problems, was not helpful (kept with the ceiling at 0), cost 0 budget, and the engine's 'buy' option handed over the area-1 lock item.

## Fix
- `goalWriteProblem` has a `trade` case: goal / lock items are refused at any price.
- `boundProblem`: every traded item must cost at least `tradeFloor` = ceil(item.value / 2) (also inside offer options).
- `isHelpfulAction('trade')` is true when any price is below the item's value (a bargain is part gift), so it counts against the help ceiling.
- `stateGoalProblem`: a trade from a hostile actor is refused.
- NPC dialogue trades are still dropped (dropTrades), as before.

## Known limit
GM_ACTION_COST.trade is still 0 (src/schema/gm.ts, not owned by llm) and the engine itself accepts any price; the LLM path can no longer produce such a trade, but a fixed engine-side floor would be belt and braces.

## Regression test
tests/llm/gm-fiat-r2.test.ts 'GM trade'.
