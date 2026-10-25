# Talker bot circles forever between two targets (rare stuck run; the game is not soft-locked)

- Severity: minor
- Area: sim (src/engine/sim/bots.ts, src/engine/sim/view.ts)
- Status: fixed

## Evidence
corporate-merger-kitchen (and -nb), talker, seed 67, normal: `stuck` with "no progress for 400 actions in area 2 (not at the way onward)". These were the only 2 stuck runs out of 8000. From turn ~1250 to 1652 the bot repeated a 7-move cycle (sw,sw,w,se,ne,n,ne) through (24,20)-(27,18). The exit was open and reachable.

## Root cause
The report guessed at the friendly NPC carol-payroll at (22,20). A decision trace showed she was not the target: she was already talked to three times, and talk was legal whenever the bot stood at (24,20). `navigate()` was flip-flopping between two frontier tiles, (22,27) and (28,13). The talker avoids hostiles, so path costs include a penalty near them. Two hostiles moving near (22,27) shifted that tile's cost between 7 and 13, so the best-scoring target changed every 3–4 decisions. The no-progress check (give up after 25 decisions without getting closer) lived on `mem.target` and reset whenever the target changed. It never fired. The trail check only catches pacing over 3 tiles or fewer, and this cycle used 6.

## Fix
- `BotMemory.progress` holds a record per target (best cost, decision of the last improvement, decision it was last chosen) for the whole area. `trackProgress()` gives up on a target after 25 decisions without beating its best cost. That holds even when the decisions are interleaved with another target. As before, the clock counts decisions, so resting or fighting in between counts too. A record starts over only when another target replaced it for more than 10 decisions.
- Targets are keyed by `TargetKey`: a tile index, or an actor instance id for actors. Talk and defeat targets keep their progress and blacklist entries when the actor moves, as the report suggested.
- When the bot stands next to a talk target and talk is still not legal, it now gives up on that target, the same as interact targets. A talk target 2 tiles away that is out of sight is still approached, because talking from 1 tile away needs no line of sight.
- The chase in `fight()` uses the same progress check, keyed by actor id. On detective-sugar-hotel seed 73, an explorer paced between (16,2) and (17,3) because the hostile it chased dropped in and out of view behind a doorway.
- `lootCarriers()` (view.ts): a hostile that drops an item the bot needs counts as a wanted defeat while no copy is on the floor or in the pack. On cyberpunk-rooftop-yams seed 15, the talker sat locked in area 1 because the lock item (override-chip) is carried by the Irrigation Matriarch, and the talker only fights required targets.

The two later fixes cover runs that the new trajectories (from the first fix) reached. The old bot would have failed the same way there.

## Verification
Same 6000 runs before and after (20 worlds × explorer/cautious/talker × seeds 1–100, normal):
- before: 2 stuck (the seed-67 pair); wins: explorer 973, cautious 485, talker 1046
- after: 0 stuck; wins: explorer 997, cautious 519, talker 1040
- one cautious run (microscopic-root-nodule seed 22) hit the 3000-turn cap in the last area while still making progress (`timeout`, not a soft-lock)

## Regression tests
tests/sim/target-progress.test.ts:
- `trackProgress`: patience is unchanged for a single target; getting closer keeps the target; two see-sawing targets (the seed-67 cycle) are both given up; a target replaced by another for a while starts over; the clock keeps running across rests
- `lootCarriers`: lists a hostile that drops a needed item, and stops once a copy lies on the floor
- corporate-merger-kitchen and -nb, talker, seed 67: not stuck and past area 2
- cyberpunk-rooftop-yams, talker, seed 15: not stuck
