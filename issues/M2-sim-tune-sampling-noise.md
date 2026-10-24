# tuneWorld re-tuned in-band fixtures on sampling noise and made them too hard

- Severity: major
- Area: sim/balance (src/engine/balance/analyse.ts, tune.ts, src/engine/sim/run.ts)
- Status: fixed

## Evidence
The explorer win rate over 20-seed windows swings widely: ship 0.65/0.55/0.35/0.45/0.55 and teen 0.70/0.30/0.65/0.50/0.60, against 100-seed means of 51% and 55%. `tuneWorld(teen, { fast: true })` on seeds 1-20 judged teen too_easy at 70% and applied hostiles ×1.15 and 40% less healing. On holdout seeds 101-200 the tuned teen won about 22%, below the normal band. Ship with bridge-keycard restored hit the same problem: called too_easy at 0.70 and pushed down to 0.25.

## Fix
- Confidence-aware verdicts: new `wilsonInterval(won, runs, z = VERDICT_Z = 1.645)` gives a 90% Wilson interval. A world is too_hard or too_easy only when the whole interval misses the band. A point estimate outside the band whose interval overlaps it stays `ok`, with the reason "… but within sampling noise (90% interval a–b over n runs); run more seeds to tell". `VerdictResult` gained optional `interval` and `runs`. Teen at 14/20 now gets ok (interval 52–84%).
- tuneWorld defaults to `TUNE_DEFAULT_SEEDS = 60` seeds. `analyseWorld` keeps 20.
- Fresh-seed checks (`confirmReport`, `TuneOptions.confirm`, default true):
  - A too_hard or too_easy verdict on the input world is re-checked on a fresh, disjoint seed block, pooled using `mergeSummaries` from sim/run.ts, before any rebalancing.
  - A rebalanced candidate that looks at least as good as the best so far is re-checked the same way before it can replace the best.
  - `TuneStep.runs` records how many runs a verdict rests on.
- `tuneDistance`: too_hard and too_easy now score 1+, and ok scores below 0.1. Among ok worlds, one whose interval covers the band centre scores 0. One that only reaches the band edge scores 0.1 × the gap between its interval and the centre.

## Regression test
- tests/balance/m2-sim-noise.test.ts covers Wilson values, the review's 13/20 and 14/20 windows being ok, the same rate over more runs being confident, tuneDistance preferring the centre, mergeSummaries matching summarize, the default of 60 seeds, and `confirmReport` pooling fresh seeds. It also replays the review repro: `tuneWorld(teen, { seeds: 20 })` leaves the world untouched, or acts only on a verdict that held over 40 runs.
- tests/balance/m2-fixes.test.ts: the NPC-boss tuneWorld test now uses 12 seeds (0/8 is not confidently below 25%) and checks that round 0 rests on 24 runs.
