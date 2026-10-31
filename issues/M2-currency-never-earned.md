# Currency is never earned in a run, so traders go unused after the starting purse

- Severity: major
- Area: schema (Effect), engine (effects.ts, describe.ts), content (all 4 fixtures)
- Status: fixed. Offline-director payouts are still optional (client owner).

## Evidence
In the full round-2 runs (docs/archive/progress/M2/playtest-r2-fixture-*.json and the play-*.png HUDs), currency never changed:
- ship stayed at 15 ration chits to turn 1092;
- teen stayed at 25 favours to turn 702;
- western stayed at 20 silver to turn 777;
- dream stayed at 20 drops of linseed to turn 913.

Kills, loot and quests paid XP or reputation but never currency. `startCurrency` covered one cheap purchase.

## Root cause
Content had no way to pay currency. Only the GM `currency` action and GM quest rewards could, and the offline director uses neither. Each trader also appeared only in the first area, so money earned later had nowhere to go.

## Fix
- **Contract, backwards compatible.** New Effect `{ type: 'currency', amount: int 1..100 }`. It is a payout only; prices stay on the GM/trade `currency` action.
- **Engine.**
  - `applyActorEffect` adds the amount to `player.currency` and logs `+N <currency>` as loot, whoever the effect lands on (like `grant_xp`). So an on_death trigger on a hostile works as a bounty.
  - `effectLine` describes the effect as `+N <currency>`.
- **Content.** Bounties are on_death triggers, using self targeting.
  - Ship (ration chits):
    - pruning drone 2, spore choir 4, vent eel 3, custodian unit 6, Warden Ostrova 15;
    - Bosun Kettering is also placed near the exit of the Ductworks.
  - Teen (favours):
    - lurker 2, prankster 3, hall monitor 4, paparazzo 2, dam surveyor 4;
    - the Janitor is also at the Friday assembly.
  - Western (silver):
    - coyote 1, deputy 3, claim jumper 4, scrap crawler 4, lodestone mole 3, Sabine Lark 20;
    - the bounty is on the scrap crawler because a tinplate prospector turns into one instead of dying;
    - Widow Oquendo is also placed at the mouth of the Lodestone galleries.
  - Dream (drops of linseed):
    - running drip 2, dissonant moth 1, acute angle 2, hungry bloom 2, Möbius eel 3, concentric stare 3, perspective warden 5;
    - Old Umber is also placed near the exit of the second layer.
  - Crew (sleepwalkers / woken crew), the summoned Washes of Grey and the final bosses pay nothing. Harming crew stays a bad choice, and a summon loop cannot farm money.

## Result
30 seeds without a GM, from an onStep tally:

| world | earned per run (explorer) | spent per run |
|---|---|---|
| ship | ~49 | 6-12 |
| teen | ~61 | ~43 |
| western | ~77 | ~0 (the bots rarely buy, see below) |
| dream | ~23, before the drip/moth bump; about 30 after | ~15 |

Win rates at 100 seeds stay in the normal band:

| world | explorer | talker |
|---|---|---|
| ship | 57% | 59% |
| teen | 47% | 63% |
| western | 51% | 52% |
| dream | 47% | 63% |

## Notes
- A bounty pays on any defeat, including one by a hazard or an ally, because triggers carry no killer filter. That is the intended "the canvas / town pays for it gone" reading.
- The sim bots buy only wanted items, upgrades, or heals when holding fewer than 3. Western bots seldom buy, but a human player has 60-80 silver to spend. This is bot behaviour, not content.
- Possible extra (client owner): the offline GM director could pay small `currency` amounts at milestones.

## Regression test
`tests/content/m2-currency-persuade.test.ts`. It covers four things:
- a bounty pays exactly once on a kill;
- the effect is validated (1..100, integer) and described;
- each fixture has ≥ 2 paying hostile kinds in every area before the last, and a trader placed again after area 0;
- the explorer earns at least one trader item's worth per run.
