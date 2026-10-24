# Balance difficulty (easy/normal/hard) did not match the client (gentle/normal/hard/brutal)

- Severity: minor
- Area: sim/balance (src/engine/balance/analyse.ts, tools/sim.ts)
- Status: fixed

## Evidence
`Difficulty = 'easy'|'normal'|'hard'` with `WIN_RATE_TARGETS[difficulty] ?? WIN_RATE_TARGETS.normal`. `tools/sim.ts --difficulty brutal` printed "target 25%–60% for brutal" (the normal band) with no error.

## Fix
- Balance uses the shared `Difficulty` from src/schema/gm.ts, the same enum the engine (engine/difficulty.ts) and client use. analyse.ts re-exports it with `DIFFICULTIES = Difficulty.options`.
- Bands: gentle 50–85%, normal 25–60%, hard 12–40%, brutal 5–25%.
- New `targetFor(d)` throws `unknown difficulty "x" (known: …)`. verdictFor and analyseWorld use it, so there is no silent fallback.
- tools/sim.ts rejects unknown `--difficulty` values (exit 1), and its help lists the four levels.

## Regression test
tests/balance/m2-fixes.test.ts, "difficulty bands": checks the levels and bands (each stricter than the last), that 'easy' throws, the brutal band and label, and that the CLI exits 1 with the message. tests/balance/balance.test.ts uses 'gentle' instead of 'easy'.
