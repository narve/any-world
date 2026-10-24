# Trader dialogue and GM trade labels reveal the real name of unknown items

- Severity: major
- Area: engine (src/engine/npc.ts doTalk trader stock, src/engine/gm.ts applyOne('trade'))
- Status: fixed

## Evidence
With `murk` at knowledge 'unknown', the option labels were "Murky Draught (10 coins) | Goodbye" and "Murky Draught (0 coins) | Leave". Both were built from `ItemDef.name`. Buying the item then logged the appearance label, so the player learned which appearance belonged to which item.

## Fix
Both labels now use `displayItemName(ctx, id)`, which gives the appearance label while the item is unknown and the real name once it is known.

## Regression test
tests/engine/review-r2.test.ts, "review r2: trade labels keep unknown items unknown" (trader, GM trade, and a known item still shows its real name).
