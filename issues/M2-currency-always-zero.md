# Currency is 0 for the whole run in every demo world, so traders can't be used without an LLM GM

- Severity: major
- Area: schema (PlayerSpec), engine (createGame), content (all 4 fixtures)
- Status: fixed (start purse). Earning during a run: fixed by the `currency` effect + fixture bounties, see M2-currency-never-earned.md.

## Evidence
In all 4 winning playtest runs the header showed 0 currency from start to finish (ship turn 1022 "0 ration chits", western 723 "0 silver", dream 389 "0 drops of linseed", teen 578 "0 favours"). The engine starts currency at 0 (src/engine/index.ts createGame). The only sources are the GM `currency` action and quest rewards, and the offline director gives neither. The trade panel listed items at 4-40 but nothing could be bought.

## Root cause
A world had no way to give the player money without a GM, and the fixtures never planned for a trader being usable offline.

## Fix
- **Contract (backwards compatible).** Optional `player.startCurrency` (int 0..9999) in src/schema/world.ts PlayerSpec. createGame sets `player.currency = world.player.startCurrency ?? 0`, so worlds without the field still start at 0.
- **Fixtures.** Each start purse covers at least one of the four items the trader shows (npc.ts offers `stock.slice(0, 4)`):
  - ship: 15 ration chits (O2 canister 10, ration brick 4)
  - teen: 25 favours (scrunchie 20, mixtape 25)
  - western: 20 silver (sarsaparilla 6, cartridges 8, antivenom 12)
  - dream: 20 drops of linseed (tube of rose 12, linseed drop 10, confetti 15, fixative 20)
- The purses are part of the balance sweep in M2-fixtures-too-easy.md, since the sim bots buy wanted items.

## Not fixed here (other owners)
- **Earning currency offline during a run.** Options are an Effect `{type:'currency'}` so loot and on_kill triggers can pay out (engine), or a small `currency` action at milestones in the offline GM director (client/gm-director.ts).
- **Selling to traders.** Not implemented in npc.ts.

## Regression test
tests/content/fixtures-m2.test.ts, "currency is usable without a GM". This checks that createGame applies startCurrency, that every trader has an affordable offer, that a world without the field starts at 0, and that negative or fractional values are rejected.
