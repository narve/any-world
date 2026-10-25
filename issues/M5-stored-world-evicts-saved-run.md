# Keeping a new world evicts the world of the autosaved run

- Severity: major (M5 review round 1)
- Area: src/client/storage.ts (saveGeneratedWorld), src/client/worlds.ts, src/client/main.ts (importWorld), src/client/world-file.ts
- Status: fixed

## Evidence
After 6 imports/generations the saved run's world was gone; Continue vanished and continueRun showed app.savedMissing. A 2 MB file could push every other world out through the quota path.

## Fix
saveGeneratedWorld never evicts the entry whose id is loadRun()?.worldId (or the one being saved), for the cap and the quota loop; if the world still does not fit it returns false and changes nothing. rememberWorld reports `stored`; importWorld then shows world.import.error.noRoom instead of 'Opened'. World files are capped at 600 kB.

## Regression tests
tests/client/stored-worlds-saved-run.test.ts (moved from tests/review/m5), tests/client/m5-client-fixes.test.ts 'stored worlds vs. the autosaved run'.
