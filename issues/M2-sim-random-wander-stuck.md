# Random-bot wandering was reported as "stuck" alongside real soft-locks

- Severity: minor
- Area: sim (src/engine/sim/run.ts)
- Status: fixed

## Evidence
Teen seeds 52, 77, 153 and western seed 254 with the random bot ended "no progress for 400 actions in area 0 (not at the way onward)". The trace showed a random walk inside a room at full hp with no pending choice. verdictFor already left out the random bot, but the CLI table and stuck seeds listed these runs next to real soft-locks.

## Fix
- runGame: when the random bot stalls, the outcome is `timeout` with the cause `wandering: no progress for N actions in area A (why)`. Goal-seeking bots (explorer, cautious, talker) still report `stuck`. The free-action-loop check is unchanged for every bot.
- BotSummary gains `timeoutCauses`. formatSummary prints a "timed out:" line with causes and seeds, so wandering stays visible without counting as a soft-lock.

## Regression test
tests/balance/m2-fixes.test.ts, "random-bot wandering is not a soft-lock": on a sealed-exit map the explorer is `stuck` and the random bot is a `wandering:` timeout. On an open room the random bot is never `stuck`.
