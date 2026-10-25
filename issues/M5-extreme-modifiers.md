# Unbounded modifier amounts let a schema-valid world push player hp to Infinity/NaN

- Severity: minor
- Area: schema (src/schema/world.ts)
- Status: fixed

## Evidence
`modifiers[].amount` (perks, items, statuses) and `modify_stat.amount` were bare `z.number()`. With
every fixture-teen perk set to [{hp:1e308},{mp:1e308}] parseWorld accepted the world and
runGame(explorer, seed 1) crashed with "invariant: actor a1 has a non-finite hp/energy" (8/8 runs).
Repro: tests/review/m5/extreme-modifiers.test.ts.

## Fix
New `ModifierAmount = z.number().min(-100).max(100)` used by all three modifier lists and
`modify_stat.amount`. Shipped worlds use at most ±20 (checked over every world JSON in the repo), so no
content changes. Fractions stay allowed.

## Regression tests
tests/engine/m5-robustness.test.ts "modifier amounts are bounded": 1e308 perks refused, ±101/−1e9
refused on items/statuses, ±100 accepted, and the largest allowed perk modifiers play without a crash
(moved from tests/review/m5/extreme-modifiers.test.ts).
