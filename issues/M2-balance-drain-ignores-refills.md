# Static drain harm ignored refills (risk >2 in every dream/ship area; too_easy printed "add healing")

- Severity: minor
- Area: sim/balance (src/engine/balance/rules.ts resourceDrainHarm, static.ts, analyse.ts verdictFor)
- Status: fixed

## Evidence
`resourceDrainHarm` assumed the resource is empty half of the time, whatever refills it. That gave 187 "rule dmg" in every dream area and 168 in every ship area, risk 2.35–3.25, while the explorer won 86% and 52%. `verdictFor` then added "add healing to its item table…" for every risky area, next to the too_easy advice "cut healing".

## Fix
- `resourceDrainHarm` now tracks the resource level area by area. It starts at `start` and drains by `perTurn` plus on_turn rule flows (draining ground counts at a small share). Refills come from:
  - spawn-table items, weighted by their share of `itemCount` (`itemProfile().resources`; charges multiply)
  - placed items
  - onStand terrain, at 10% of the area's turns
  - on_area_enter refills (capped by `max`)
  - on_kill refills
- Only the turns the supply cannot cover are counted as empty, at the onEmpty rate (every 5 turns). emptyIsDeath adds a flat 60. Result fields: `perArea`, `emptyTurns`, `refills` (hpPer100 / turnsToEmpty kept).
- staticAnalysis uses the per-area figure for `ruleDamage`. `AREA_TURNS` moved to rules.ts and is exported.
- verdictFor adds per-area "add healing" and "soften rule" suggestions only when the verdict is not too_easy.
- Now: dream rule dmg is 7/7/19/9 (risk 0.44–1.43), ship 13/119/18. Ship area 2 is large and is the only area where the drain still outruns the refills.

## Regression test
tests/balance/m2-fixes.test.ts, "resource drains count their refills":
- ship and dream: at most one area has rule damage above 100, and area 1 risk is below 1.
- A ship copy without canisters, moss or area-entry top-ups has more empty turns and harm in every area.
- A too_easy verdict has no "add healing" suggestion, and too_hard still has it.
