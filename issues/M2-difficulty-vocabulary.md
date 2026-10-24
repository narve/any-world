# Difficulty vocabularies diverged: client gentle/normal/hard/brutal vs balance easy/normal/hard

- Severity: minor
- Area: schema (src/schema/gm.ts Difficulty), engine (difficulty.ts), balance (analyse.ts, done by the sim/balance fixer, see M2-balance-difficulty-enum)
- Status: fixed

## Evidence
src/client/ui/viewmodel.ts used 'gentle'|'normal'|'hard'|'brutal', while balance/analyse.ts used 'easy'|'normal'|'hard' and fell back to normal without a warning.

## Fix
There is one enum, `Difficulty`, in src/schema/gm.ts. The engine (NewGameOptions/GameState.difficulty, DIFFICULTY_PROFILES) and balance (WIN_RATE_TARGETS for all four bands, `targetFor` throws on unknown values) both use it. The client's own `Difficulty` type in viewmodel.ts has the same members, so it can import the schema one.

## Regression test
tests/engine/difficulty.test.ts (engine bands) and tests/balance/m2-fixes.test.ts "difficulty bands" (balance).
