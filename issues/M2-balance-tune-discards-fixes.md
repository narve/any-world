# tuneWorld returned the untouched input when no round strictly improved the distance

- Severity: major
- Area: sim/balance (src/engine/balance/tune.ts, rebalance.ts)
- Status: fixed

## Evidence
`distance()` had three coarse values: 0.25 at 0% wins, 5 for unwinnable and 10 for broken. `best` was replaced only on a strict `<`. Repro 1: after 3 rounds of ×0.7 scaling the hostile hp in the result was identical to the input. Repro 2: western with lode-key only in area 3 plus a deadly drain. Round 1 logged 'placed missing item "lode-key" in area 2', but the returned world had `areas[1].placedItems == []`, because the drain kept the verdict at unwinnable.

## Fix
- New exported `tuneDistance(report)`. The verdict class still dominates (broken 100+, unwinnable 50+, then the band distance). Inside a class, finer signals rank the worlds: number of static issues, crash and soft-lock share, and for worlds below the band the win rate plus a small term for mean depth reached. Dying later counts as progress at 0% wins.
- Ties go to the later round (`<=`).
- Feasibility fixes are always kept. If the chosen world still has static issues, `feasibilityFixes()` (new export in rebalance.ts, which places only the missing goal/lock items and actors and re-validates) runs on it and the result is analysed once more.

## Regression test
tests/balance/m2-fixes.test.ts, "tuneWorld keeps progress and feasibility fixes":
- tuneDistance ordering: deeper beats shallower at 0%, a higher win rate wins, fewer issues win, and the verdict class dominates.
- Repro 2 as a test: the returned world has lode-key placed in area 2 and 1 static issue left (not 2).
