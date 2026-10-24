# tuneWorld could not repair a too-easy world

- Severity: major
- Area: sim/balance (src/engine/balance/rebalance.ts, tune.ts)
- Status: fixed

## Evidence
I made a copy of the ship fixture with hostile hp and attack damage ×0.35, then ran `tuneWorld(w)` with the defaults (60 seeds, explorer + cautious bots). The history was too_easy at every round: 97.5%, 91.7%, 93.3% and 95%. The tuned world still scored 97% explorer on holdout seeds 1001-1100. There were three causes:
1. `scaleAmount({base: 1, dice: '1d4'}, 0.35)` returned `{base: 0, dice: '1d2'}`. Because of `if (out.base)`, a base of 0 was never scaled up again. Three rounds of ×1.3 reached at most `1d5`, and all 8 ship hostiles ended with base 0. Hostile hp 1 also stayed at 1 (`round(1 × 1.3) = 1`).
2. too_easy rounds scaled by ×1.3 at most. 1.3³ = 2.2, which is less than 1/0.35 = 2.86.
3. `tuneDistance` for too_easy is `1 + (winRate − hi)`. Sampling noise made round 1 (the least corrected round, at 91.7%) look better than rounds 2 and 3, so round 1 was kept as the best world.

## Fix
- `scaleAmount` now scales the expected value (base + dice mean) and re-splits it. The dice keep their count, and the number of sides is round(sides × f) ±2 (at least 2), whichever gets the mean closest to the target. The base absorbs the rounding. A non-zero base keeps its sign and stays at magnitude ≥ 1. A zero base can only become positive. Old documented results are unchanged (`{4,2d6}×0.5 → {2,2d3}`, `{1,1d2}×0.5 → {1,1d2}`, `{0,1d8}×1.5 → {0,1d12}`).
- Hostile hp scaling (`scaleStat`) moves by at least 1 whenever f ≠ 1, within 1–500.
- `tooEasyFactor(winRate, hi) = clamp(1 + 1.5 × (winRate − hi), 1.15, 1.6)` replaces the fixed ×1.15 / ×1.3. A normal-band world at 97.5% now gets ×1.56.
- New `preferCandidate(candidate, best)` in tune.ts: when both worlds are too_easy, the later round always wins. too_easy rebalancing only makes hostiles stronger and healing rarer, so a later world that is still too easy is at least as close in expectation. In every other case it falls back to `tuneDistance` (ties go to later rounds). It decides both the fresh-seed re-check and which world is kept as best.

## Regression test
tests/balance/m2-tune-too-easy.test.ts covers:
- the old `scaleAmount` results;
- the ×0.35 repro amount, where the base survives and the mean recovers after 3 × 1.3;
- the scaled mean staying within 1 of the target;
- negative bases;
- `tooEasyFactor` values;
- a hp-1 / ×0.35 ship regaining hp and bases after one rebalance;
- `preferCandidate` picking round 3 (95%) over round 1 (91.7%).
