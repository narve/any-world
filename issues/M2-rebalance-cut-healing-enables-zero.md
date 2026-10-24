# rebalance cutHealing re-enabled healing spawn entries that had weight 0

- Severity: minor
- Area: engine/balance (src/engine/balance/rebalance.ts cutHealing)
- Status: fixed

## Evidence
`e.weight = Math.max(1, Math.round(e.weight * 0.6))` turned a disabled (weight 0) 'ampoule-medgel' entry into weight 1 when the verdict was too_easy.

## Fix
Entries with weight ≤ 0 are skipped. Enabled entries keep a floor of 1 and are only counted as changed when their weight actually dropped.

## Regression test
tests/balance/rebalance-rules.test.ts "too_easy never enables a healing spawn entry that had weight 0" (moved from tests/review/m2/round1.test.ts).
