# Paid GM offer can take the price and skip the goods when the area GM budget runs low

- Severity: major
- Area: engine (src/engine/gm.ts applyGmList / offer_choice, src/engine/npc.ts doChooseOption)
- Status: fixed

## Evidence
The chosen option's actions were charged one at a time against `area.gmBudget` when the option resolved (`charge: pc.kind === 'gm_offer'`). Async GM hooks spent the budget between the offer and the choice (3x grant_xp). The `currency -10` (cost 1) still fitted, but `give_item` (cost 3) was skipped as "over budget". Result: `{ paid: 10, gotCoat: false }`.

## Fix
The budget is reserved when the offer is made. `gmActionCost(offer_choice)` is the offer's own cost plus the most expensive option's total. If that does not fit, the whole offer is skipped. The reservation is stored in a new optional `PendingChoice.reservedBudget`. `doChooseOption` always applies the option with `charge: false` and refunds `reservedBudget - cost(chosen option)`, and declining an unaffordable choice refunds all of it. A chosen option is therefore applied whole. Options with invalid references are already dropped when the offer is made (see M1-gm-offer-unaffordable-softlock).

## Regression test
tests/engine/review-r2.test.ts, "review r2: paid GM offers are atomic" (price and goods both delivered after the budget was spent, reservation and refund amounts, an offer that does not fit is not made). tests/engine/game.test.ts is updated: choosing an option no longer charges the budget again.
