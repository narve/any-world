# Traders only offered the first 4 stock entries; later items (incl. all fixture armour/gear) could never be bought

- Severity: major
- Area: engine (src/engine/npc.ts doTalk, case 'trader')
- Status: fixed

## Evidence
`for (const id of npc.stock.slice(0, 4))` while the schema allows `stock.max(8)`. Western seed 1 explorer trace: widow-oquendo only ever offered Sarsaparilla, Cartridges, Dynamite, Antivenom; buffalo-coat (70) and lucky-horseshoe (45) never appeared. Ship bosun: pressure-suit, grav-boots, moss-poultice unsellable; teen janitor: iced-tea, power-bank, megaphone, detention-eraser; dream old-umber: gesso-shell, moire-loop. Over 20 seeds western explorer/talker made 0 purchases (103/88 unspent currency). Screens docs/progress/M2/playtest-r3-econ-fixture-western-trade.png, playtest-r3-ui-ship-12-trade.png show exactly 4 rows. Reported twice (balance reviewer and playtester).

## Fix
The trader dialogue lists the whole stock (at most 8 by schema), in authored order. Bounding the visible list (paging) is the view's job, not the engine's. Every buy option keeps its price, so unaffordable rows are still shown and refused with "not enough <currency>" by doChooseOption.

Note for client: a trader dialogue can now have up to 10 options (8 buys + "Ask what they know" + "Goodbye"); digit keys only cover 1-9, so the 10th option (Goodbye) needs a click or the modal's close/escape.

## Regression test
tests/engine/trader-stock.test.ts: for every trader in all four fixtures, every stock id is offered as a 'buy' option in authored order and Goodbye is last; and the fixtures do contain traders with more than 4 items.
