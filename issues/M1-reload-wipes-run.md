# Reloading a ?world= link wipes the autosaved run and starts over

- Severity: major
- Area: client (src/client/main.ts boot / playWorld, src/client/boot.ts, src/client/storage.ts)
- Status: fixed

## Evidence
Opened `/?world=fixture-teen&seed=4`, played to turn 7 at (41,5), reloaded: back to turn 0 at (41,3) with the prologue, and the save was cleared. `boot()` called `playWorld()`, which runs `clearRun()` before starting. Shared or bookmarked demo links behaved the same way. "Continue" from the start screen worked (script: scratchpad/pt/cont.mjs).

## Fix
- Boot routing is now a pure function, `bootRoute(search, savedRun)` in `src/client/boot.ts`. `boot()` never calls `clearRun()`:
  - `?world=X[&seed=N]` with a saved run of the same world (and the same seed, when the link gives one) resumes that run.
  - `?world=` while a run of a different world or seed is saved opens the start screen, which offers Continue and the demo worlds, with a notice. Starting over is the player's choice.
  - With no saved run, the world starts fresh, as before.
- The address bar always names the run on screen. `App.launch` calls `history.replaceState` to `?world=<id>&seed=<seed>` (new runs, continued runs and "same world" restarts), and the start screen resets it to the bare path. Reloading or sharing the URL therefore gets back to the same run.
- `SavedRun` gains an optional `seed` (set from `GameState.seed` in `GameSession.savedRun`), so a reloaded link can tell whether the save belongs to it. Older saves without a seed are treated as matching, because resuming is safer than discarding.

## Regression test
- tests/client/boot.test.ts covers routing, `runUrl` round-trip and seed parsing, and checks that `boot()` has no `clearRun` on its path.
- tests/client/narration-dismiss.test.ts checks that the autosave carries the seed.
