# M2 — Bot simulation & balance report

Date: 2026-10-24. Author: sim & balance agent. Reproduce with:

```bash
npm run sim -- --seeds 100 --bots explorer,cautious,talker --analyse   # 1200 runs, ~70 s on 15 workers
npm run sim -- --seeds 50 --bots cautious,random --gm                   # scripted GM actions
npm run sim -- --world content/worlds/fixture-ship.json --seed-start 7 --seeds 1 --bots cautious   # one repro
```

## Summary

| World | Explorer win | Cautious win | Talker win | Stuck | Crash | Verdict (normal: 25–60%) |
|---|---|---|---|---|---|---|
| fixture-ship (*The Long Quiet of the Halcyon Tithe*) | 52% | 42% | 60% | 0 | 0 | **ok** |
| fixture-teen (*Lowmoor Goes Under*) | 82% | 62% | 82% | 0 | 0 | too easy |
| fixture-western (*The Rain Broker of Sweetwater*) | 78% | 46% | 81% | 0 | 0 | too easy |
| fixture-dream (*The Fourth Primary*) | 86% | 81% | 100% | 0 | 0 | too easy |

- **No crashes, no soft-locks, no invariant breaks.** No action from `legalActions` was ever refused by `step()`. This covers 1,200 runs of 100 seeds × 3 goal-seeking bots, 400 more runs with the scripted GM (cautious + random), and the earlier development sweeps.
- With the scripted GM on, there were no crashes either. The GM spawns, makes `offer_choice` offers, gives gifts and grants xp each area. **`add_rule` and `remove_rule` are still refused by the engine as "unsupported"**, because that is pending engine work. The script sends them anyway, so they will be exercised once they land.
- Every world can be won by every goal-seeking bot. The random bot never wins (as expected): it dies or times out, and never crashes.
- `fastStep`, used by the simulator, gives the same results as the public `step()`. The `--exact` and default runs produced identical summaries, and `tests/sim/fast.test.ts` checks state and event parity on every world.

## Per world

### fixture-ship — ok (explorer 52%)

```
bot        runs   won  lost stuck crash  t/o  avgTurns  wonTurns  kills  lvl  areas reached
explorer    100   52%   48%    0%    0%    0%       978      1019   20.1  4.2   0 / 15 / 85
cautious    100   42%   58%    0%    0%    0%       644       702   16.5  3.6   0 / 25 / 75
talker      100   60%   40%    0%    0%    0%       978      1011   19.1  4.3   0 / 13 / 87
```

- Deaths (explorer): Custodian Unit 19, oxygen ("Vacuum") 14, MATRON's Proxy 13.
- **Oxygen is the signature threat, and it works.** It accounts for 14–28% of deaths depending on the bot. Most are in area 2 (The Ductworks maze), where full exploration outlasts the 120 O2 plus the +40 refill on entering the area.
- Suggestion for the fixture agent (optional): one or two `o2-canister` entries in The Ductworks item table, or a moss patch (terrain with an O2 `onStand`), would turn the maze from a slow drain into a choice.
- The Custodian Unit (guardian, hp 20, AC 14, 1d8+1) kills more explorers than the boss does. That is fine for "normal", but it is the first thing to tune if the ship ever reads as unfair.

### fixture-teen — too easy (explorer 82%)

- Deaths: Mags Calloway 9, Group Chat Lurker 6 (ranged pack).
- Static budget: risk is below 1 in every area, and healing (85 hp on Monday) is more than the expected damage.
- `tuneWorld` with 40 seeds and 3 rounds lands at **55%** after hostile hp/damage ×1.15 three times (≈ ×1.5 overall) and 40% less frequent healing items. Suggested hand edit instead: drop `iced-tea`/`admirer-note` weights by about half, and give Mags +10 hp or 1d8 instead of 1d6.

### fixture-western — too easy (explorer 78%)

- Deaths: Absalom Vane 11, Tinplate Prospector 9. The cautious bot does much worse (46%): it skips fights, so it reaches the Cistern under-levelled.
- `tuneWorld` lands at **38%** after two rounds of ×1.15 hostile scaling and 40% less frequent healing. Suggested hand edit: Absalom Vane hp 52 → 64, and fewer `sarsaparilla`/`cactus-poultice` drops in area 1.

### fixture-dream — too easy (explorer 86%)

- Deaths: The Erasure 11. The lose condition (`colours-spilled ≥ 30`, which kills feed through `violenceCounter`) is nearly binding. Before the bots learned restraint, a full-clear explorer averaged 29 kills and lost **39%** of its runs that way. Now it is 1%. **The kill cap is a real design lever.** A player who clears everything will hit it, so the world should telegraph it (e.g. a GM line at 20).
- The talker wins 100%: the persuade plus avoid style is very strong here. If that's not intended, raise `persuadeDifficulty` on the hostiles.
- `tuneWorld` lands at **50%** after three rounds of ×1.15 scaling.

## Bots

`src/engine/sim/bots.ts`, built on read-only helpers in `src/engine/sim/view.ts`.

| Bot | Style |
|---|---|
| explorer | Explores every reachable tile. Fights what it sees, loots, equips upgrades, heals below 40%, tries unknown items when calm, talks to each NPC once and uses healer/trader/quest services, interacts with terrain. Leaves when the area is done (the lock is met and nothing is left), or hurries if a draining vital resource runs low. |
| cautious | Fights only what blocks it or is required. Steps away from melee and kites. Sneaks, except when a vital resource drains (sneaking makes each step slower). Heals at 55% and leaves once the way out is known and the lock is met. |
| talker | Persuades hostiles in reach (up to twice each, never a required target) and talks to everyone. Otherwise behaves like the explorer. |
| random | Random legal actions with a bias toward the exit. Used for fuzzing; 50% transition when legal. |

Shared behaviour:

- **Choices:** level-ups pick the strongest perk. Pending choices are scored: heal service when hurt, gifts and recruits, buying only wanted or upgrade items, declining unaffordable GM offers.
- **Goal planning:** objectives come from `goal.win` and the current `transitionRequires`: items, defeats, flags, counters, areas and waits. For an `any` goal, the bot picks the cheapest branch. A flag set by an item with a use-condition also needs that condition. This fixed a talker soft-lock in teen, where persuading Mags made the speech impossible.
- **Survival:** heals, cures, refills vital resources from items or by standing on refill terrain, keeps lose counters down, and holds back from kills when a violence counter feeds a lose condition.
- **Stuck handling:** target hysteresis, blacklisting targets that make no progress, refused moves, two-tile pacing detection, then searching and walking into unexplored space or hunting remaining hostiles.

## Simulator and CLI

- `runGame(world, seed, bot, {maxTurns, stallSteps, gm, fast, mapGenerator, invariants, onStep})` returns `{result: won|lost|stuck|crash|timeout, turns, steps, areaReached, cause, stats, anomalies}`.
- **Cause** names the killer from the engine end reason, or the last damage source or damage type. For `stuck` it gives the area and the transition blocker; for `crash` it gives the error and stack.
- **Stats:** kills, damage dealt/taken, items used, areas cleared, level, lowest hp, talks/persuades/interacts/pickups/equips, GM batches and skipped actions, legal-but-refused actions, and turns per area.
- `tools/sim.ts` (`npm run sim`):
  - Options: `--world` (repeatable/comma list, default all fixtures), `--seeds`, `--seed-start`, `--bots`, `--max-turns`, `--gm`, `--jobs`, `--exact`, `--analyse`, `--difficulty`, `--json`.
  - Output: a table per world, deaths by cause, stuck/crash causes with seeds, and an area-reached histogram.
  - Exits 1 on any crash.
  - Speed: 100 seeds × 2 bots on one world takes about 18 s, or about 50 s with `--exact`.

## Balance

- `staticAnalysis(world)` gives a power budget for each area:
  - the player's expected level, hp, damage per turn (best weapon so far) and AC;
  - each expected hostile's count, damage per turn, time to kill and damage per fight;
  - healing available (floor items, loot, healers, regeneration, healing spells);
  - rule and resource drain (`estimateRuleImpact`, local, in hp per 100 turns);
  - risk and boss risk.
- Feasibility checks find goal or lock requirements that can never be met: items or actors that never appear or appear too late, flags nobody sets, and counters nobody raises.
- `verdictFor` / `analyseWorld` return `ok | too_hard | too_easy | unwinnable | broken`, with reasons and suggestions (top killer, risky areas, harsh rules, missing placements).
- `autoRebalance` / `rebalance` make bounded edits and re-validate with `parseWorld`. `tuneWorld` loops analyse → rebalance (see the results above).
- **The static risk is not calibrated yet.** It overestimates attrition: risk 2–4 in areas the bots clear 50–80% of the time. It assumes every expected hostile is fought to the death and ignores perks, level-ups during an area, and dodging. For dream it also overcounts the hue drain, ignoring the +35 per area and pigment terrain. Use it to rank areas and worlds; verdicts come from the simulations.

## Engine findings (for the engine agent)

1. **Performance.** `step()` spends about 65% of its time in `structuredClone` of the whole state (map tiles and the 300-line log), about 1–2 ms per call. A structural clone that shares the immutable map tiles (copy on write) would speed up the UI and the server too. The simulator works around it with `fastStep`, which is checked for parity by tests.
2. **GM rules.** `add_rule` / `remove_rule` are refused with "GM add_rule skipped: unsupported". `src/engine/rules.ts` and `estimateRuleImpact` don't exist yet; the balance code has its own estimate in `src/engine/balance/rules.ts` and should switch to the engine's once it exists.
3. **Contract gap.** `step()` accepts `attack` on a neutral or friendly actor (it provokes it), but `legalActions` never lists it. A bot, or a UI that only offers legal actions, can't deliberately fight a neutral even when the goal requires defeating it (for example, a persuaded rival).
4. No crashes, refused legal actions or invariant violations were found.
