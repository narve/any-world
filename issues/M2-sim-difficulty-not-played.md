# Sim CLI, analyseWorld and tuneWorld never passed the difficulty to createGame

- Severity: major
- Area: sim/balance (src/engine/sim/run.ts, src/engine/balance/analyse.ts, tools/sim.ts)
- Status: fixed

## Evidence
`runGame` called `createGame(world, { seed, ...mapGenerator })`, and RunOptions had no difficulty field. tools/sim.ts used `--difficulty` only for `verdictFor`, and analyseWorld/tuneWorld passed it only to the verdict. So `npm run sim -- --world content/worlds/fixture-ship.json --seeds 40 --bots explorer --analyse --difficulty brutal` judged normal-difficulty games against the brutal band ("TOO_EASY, explorer wins 60%"). With the difficulty really applied, ship brutal is about 20% on seeds 1-100, which is in band. tuneWorld({difficulty:'brutal'}) would therefore harden a world that was already in band, and the engine's ×1.3 would then apply on top. Gentle got softened twice in the same way.

## Fix
- `RunOptions.difficulty` is passed to `createGame`. `SimResult.difficulty` records the band the game was actually played at (`GameState.difficulty`).
- analyseWorld passes its difficulty to `runMany`, so tuneWorld and `confirmReport` do too.
- tools/sim.ts: `Task.difficulty` reaches the workers. The per-world JSON entry has `difficulty` (taken from the results) and the table title shows it.
- After the fix: the same command on ship gives brutal 28% (interval 18–40%), verdict OK.

## Regression test
tests/sim/difficulty.test.ts. runGame creates the game at the requested band. Brutal hostiles in area 1 have more than 1.2× the hp of normal ones. Brutal and normal runs on the same seeds differ, and analyseWorld at brutal reproduces runMany at brutal exactly. The CLI's `--difficulty brutal --json` reports games played at brutal.
A win-rate comparison was left out on purpose. Over 12 seeds it is noise (teen gave normal 2/12 against brutal 5/12, while 40 seeds gave 18/40 against 13/40), and the fixtures change under other fixers.
