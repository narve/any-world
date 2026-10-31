# Sell column is dead UI: every trader said "Nothing they want"

- Severity: major
- Area: client (src/client/ui/components/modals.ts, src/client/ui/format.ts, src/client/styles/ui.css)
- Status: fixed on the client side (the column is hidden). A currency sink, meaning fuller stock or a real buy-back, is still for engine/content.

## Evidence
`tradeView()` in src/client/view.ts sets `sellable: []`, and the engine has no sell action. Every trade window had a "Sell" column that only said "Nothing they want." All 4 playtest-r3 economy runs had `sold=false` and ended with currency unspent: 71 ration chits (ship), 86-96 favours (teen), 95 silver (western), 51-53 linseed (dream). Screenshots: playtest-r3-fixture-teen-play-0450.png and playtest-r3-fixture-western-play-0450.png.

## Fix
- I took the issue's suggested fallback. The client does not own the engine, and the engine has no sell action to call, so the client cannot add selling on its own. It can stop showing a column that can never be used.
- New pure helper `tradeColumns(t)` in src/client/ui/format.ts returns `{ buy: true, sell: t.sellable.length > 0 }`.
- `TradeModal` in modals.ts now leaves out the Sell section when `sell` is false. The columns container gets `aw-trade-cols-single`, so the Buy list uses the full width. The new CSS rule is in ui.css.
- The `TradeSellView`/`sellable` contract and the `{type:'sell'}` intent are unchanged. Once the engine has a sell action and `tradeView()` fills `sellable`, the column comes back by itself. Until then, a stray `sell` intent is still a no-op with an info toast.

## Regression tests
- tests/client/trade-sell-column.test.ts: checks `tradeColumns` with empty and non-empty lists, that a real western trader's shop has offers and no Sell column, and that a stray sell intent changes no state.
- e2e/client-m2-fixes.spec.ts, "trade window shows only the Buy column…": opens the ship bosun's shop in the real app. It checks that the only heading is "Buy", that "Nothing they want" is gone, and that the single-column class is set. Screenshot: docs/archive/progress/M2/client-fix-trade-buy-only.png.

## Follow-up (not client-owned)
Currency still has little to buy. That needs fuller trader stock in content, or an engine `sell` action that pays `value/2` for owned items. For the second option, view.ts would fill `sellable` from `state.player.slots` and session.ts would send the action, and the UI is ready for that.
