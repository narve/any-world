# rebalance softenRules deleted -1 resource drains instead of halving them

- Severity: major
- Area: engine/balance (src/engine/balance/rebalance.ts softenRules, new softenAmount)
- Status: fixed

## Evidence
`scaleAmount({base:-1}, 0.5)` gave `Math.round(-0.5) = -0`, which deleted the drain. A base-1 damage stayed 1, yet the change list still said "softened (harmful trigger effects halved)". tuneWorld applies this every round, so -2 became -1 and then -0.

## Fix
`softenAmount(a, f)` keeps the sign and at least magnitude 1 (`sign * max(1, round(|v|·f))`) and keeps at least 2 dice sides. When an on_turn trigger's amounts are already at the minimum, the trigger fires half as often (`every ×2`) instead of `×1.5`. The change list now reports only what actually changed ("harmful trigger effects halved" and/or "on_turn slower"), and reports nothing when nothing could be softened.

## Regression test
tests/balance/rebalance-rules.test.ts (moved from tests/review/m2/round1.test.ts): softenAmount bounds; a -1 drain stays -1 with every 1→2 and an honest change line; four rounds never reach 0; a non-on_turn base-1 rule is not reported as softened.
