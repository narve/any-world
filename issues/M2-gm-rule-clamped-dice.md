# Damage with a negative base plus dice was priced at the clamped mean, so a lethal rule was estimated at 0

- Severity: critical
- Area: engine (src/engine/rules.ts effectHarm / avgAmount)
- Status: fixed

## Evidence
tests/review/m2/round3.test.ts 'rolled amounts with a negative base'. effectHarm returned max(0, mean) = max(0, -50 + 50) = 0 for {base:-50, dice:'1d99'}, but the engine rolls first and clamps each roll, so E[max(0, roll)] = 1225/99 ≈ 12.4 per firing. Gentle accepted it; the player lost after 2 turns.

## Fix
New `expectedPositive(c, dice)` = E[max(0, c + roll)]: plain mean when no roll can go below 0, 0 when none goes above, exact convolution of the dice distribution for small pools (n²k² ≤ 4M, which covers 1-2 dice of any size), and a normal approximation (μΦ(μ/σ) + σφ(μ/σ)) beyond that. Damage is priced with it (harm), heal likewise (help). Resource effects are not clamped per roll, so they keep the plain mean.

## Regression test
tests/engine/gm-rules-harm-r3.test.ts: the lottery repro (estimate > 100 hp/100t, gentle refuses), plus exact values for 1d99-50 and 2d6-7, the trivial cases, and the normal approximation on 99d999.
