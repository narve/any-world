# Difficulty setting (gentle/normal/hard/brutal) had no effect on the engine

- Severity: major
- Area: engine (src/engine/types.ts NewGameOptions/GameState, src/engine/difficulty.ts, actors.ts, combat.ts, turn.ts, rules.ts)
- Status: fixed
- Covers: "Difficulty setting has no effect on the engine" (balance review) and "The difficulty slider has no effect on the game" (playtest)

## Evidence
`createGame(teen, {seed:5, difficulty:'gentle'})` and `{seed:5, difficulty:'brutal'}` serialized identically, and `state.difficulty` was undefined. NewGameOptions had no difficulty field, and nothing in src/engine outside balance/ read one. Player HP and hostile stats were the same in gentle and brutal dream runs (playtest-r1-ui-start-brutal.png). The only effect was the client's offline director skipping GM spawns on gentle.

## Fix
- `Difficulty = z.enum(['gentle','normal','hard','brutal'])` is now in src/schema/gm.ts and shared by the engine, balance and client.
- `NewGameOptions.difficulty?` → `GameState.difficulty`, so saves keep it. Unknown values and older saves play as 'normal'.
- `DIFFICULTY_PROFILES` in src/engine/difficulty.ts:

  | band   | hostile hp | hostile damage | hp regen interval | GM rule harm (per rule / all GM rules) |
  |--------|-----------:|---------------:|------------------:|----------------------------------------|
  | gentle | ×0.8       | ×0.8           | ×0.75             | 1 / 1 (harsh rules need a counterweight) |
  | normal | ×1         | ×1             | ×1                | 6 / 10                                 |
  | hard   | ×1.15      | ×1.15          | ×1.25             | 12 / 20                                |
  | brutal | ×1.3       | ×1.3           | ×1.5              | 20 / 35                                |

- Hostile hp is scaled in makeActor and transformActor (hostile non-NPCs only; allies and NPCs keep their hp). Hostile damage is scaled in dealDamage only when a hostile source hits the player's side. Harm from rules, terrain and statuses without a source is not scaled. Natural regeneration uses `regenInterval()`. The GM rule check (see M2-gm-add-rule-unsupported) uses the harm allowance.
- GM budget per area is unchanged; the harm allowance limits the GM instead.

## Measured (explorer bot, 40 seeds, generated maps, scratchpad script with createGame({difficulty}) + fastStep)
| fixture | gentle | normal | hard | brutal |
|---------|-------:|-------:|-----:|-------:|
| dream   | 100% | 88% | 75% | 48% |
| ship    | 78%  | 60% | 38% | 23% |
| western | 95%  | 73% | 48% | 18% |
| teen    | 95%  | 70% | 73% | 43% |

The order holds on every fixture except teen normal vs hard (70% vs 73%, within noise at 40 seeds). A proper check needs `--play-difficulty` in the sim (see below).

## Regression test
tests/engine/difficulty.test.ts: band stored, saved and defaulted; gentle and brutal teen runs differ, with hostile max hp ordered; hp scaling for hostiles but not NPCs or allies; damage scaling only for hostile→player side; regeneration intervals.

## Follow-up (sim owner)
tools/sim.ts / sim/run.ts `RunOptions` need a `difficulty` passed to createGame (`--play-difficulty`) so the CLI and analyseWorld can play at a band. The engine side is ready.
