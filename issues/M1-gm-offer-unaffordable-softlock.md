# GM offer_choice whose options all cost more currency than the player has soft-locks the run

- Severity: critical
- Area: engine (src/engine/gm.ts offer_choice, src/engine/npc.ts doChooseOption, src/engine/legal.ts)
- Status: fixed

## Evidence
The schema allows 2-3 options, and any of them may hold a negative `currency`. When every option cost more than the player had, `legalActions()` returned `[]`. `doPlayerAction` rejects everything except `choose_option` while `pendingChoice` is set, and `doChooseOption` rejected each option with "not enough <currency>". Nothing could clear the choice, and an autosave kept the lock after a reload. Repro: the review r2 test "an offer_choice whose options all cost more than the player has...".

## Fix
- `applyOne('offer_choice')` appends an engine-built free option (`Decline`, no actions, tag `decline`) whenever no option has price 0. So every GM offer always has an option the player can afford. Options that name a missing item, actor, status or terrain are dropped, so a price can never buy nothing. An offer with no valid options is skipped.
- Defence in depth for states saved before this fix: if no option of a pending choice is affordable, `doChooseOption` accepts any index, declines the choice (refunding any reserved budget) and logs it. `computeLegalActions` then lists all indices instead of none.
- `optionPrice()` in gm.ts is shared by gm.ts, npc.ts and legal.ts.

## Regression test
tests/engine/review-r2.test.ts, "review r2: GM offers cannot soft-lock the run" (free way out, no extra option when one is free, a locked old save is declined after serialize/deserialize, invalid options dropped).
