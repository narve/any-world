# New players die very early, even on Gentle (1 win in 13 runs)

- Severity: major
- Area: sim / balance (src/engine/sim/bots.ts, src/engine/balance/{gate,analyse,rebalance,tune}.ts, tools/sim.ts) and the 20 demo worlds (content/worlds/*.json)
- Status: fixed. All 20 demo worlds pass the new-player gate on 200 fresh seeds. One remaining issue is engine-side (see "Remaining").

## Evidence
Round-2 desktop playtest (docs/archive/progress/M5/pt-desktop-r2-*.png): 13 runs over 10 demo worlds, with 1 win.

- **First-area pile-ups.** Yams went from 28 to 2 Cool in the first 10 turns, with three hostiles converging at the start.
- **Kiters on a melee-only player.** In Long Drove, two range-3 kiter moths killed a melee-only courier on Gentle.
- **Bosses.** These ended many runs: the Night Watchman, HARROW-4, Gaffer Hob, the Rain Broker and others.
- **Small heals.** Some heals restored 5–6 HP against 28–45 max HP.

No sim bot played like a new player. The explorer-band verdicts all passed while new players lost.

I measured with the new `newbie` bot, 60 seeds, before any change (`npm run sim -- --bots newbie --difficulty <d>`):

| | gentle (floor 50%) | normal (floor 25%) |
|---|---|---|
| worlds below the floor | 6 of 20: alien 45, ship 43, teen 47, western 35, folk-horror 38, heist 50 | 9 of 20: alien 17, corporate ×2 23, sugar-hotel 23, mimic 18, dream 22, western 8, folk-horror 18, heist 5 |

Area-1 spawn tables allowed up to 16 hostiles (yams: 7 guaranteed plus 4 extra). Five worlds put hostiles that outrange the player into area 1: alien's lamplighter moth, mimic's tape-measure sprite, heist's listening horn, the root nodule's streptomyces and the russ bus's snap-sladrer.

## Root cause
1. **Balance was measured only with strong bots.**
   - The explorer explores everything, tops up at 50% hp and tries every item, and the verdict bands were set by its win rate.
   - No check modelled a player who heals late, never risks unknown items and fights only what comes close.
2. **Area 1 was as crowded as later areas.**
   - Many spawn tables guaranteed 4–7 hostiles.
   - Shooters with reach 3–5 were placed against players with no ranged option.
3. **Heals were small.** Many heal items restored 10–20% of max hp.
4. **Bosses tuned for the explorer were too strong for new players.** The bosses killed most new-player runs, and the M5 band retune had just made some of them stronger (Gaffer Hob 66 → 74 hp, HARROW-4 68 → 98 hp).

## Fix
- **New `newbie` sim bot** (`src/engine/sim/bots.ts`). It follows the goal and fights only hostiles within `DEFEND_RANGE` = 3, plus anything the goal needs. It heals at 35% whether or not a fight is on, and never tries an unknown item. It walks straight at things: no sneaking, kiting or paths around hostiles. Persona fields `calmHealAt` and `tryUnknown` were added; the other bots behave exactly as before.
- **New-player gate** (`src/engine/balance/gate.ts`):
  - `NEW_PLAYER_GATE` (= `NEW_PLAYER_FLOORS`): gentle ≥ 50%, normal ≥ 25% newbie wins.
  - `newPlayerGate(world)`, `gateFromResults`, `formatGate`.
  - `npm run sim -- --gate` plays the newbie at both levels for every world and exits 1 when a world misses a floor.
  - `verdictFor` returns `too_hard` when a newbie summary at a gated level is below its floor beyond noise, so `tuneWorld` repairs it when the bot is simulated.
- **`newPlayerFixes(world)`** (`src/engine/balance/rebalance.ts`). `tuneWorld` runs it once before its first analysis, so it now applies to every generated world (`newPlayer: false` turns it off).
  - The first area's spawn table produces at most `FIRST_AREA_MAX_HOSTILES` hostiles (small 3, medium 4, large 5). At most `FIRST_AREA_MAX_GUARANTEED` = 2 are guaranteed. The most dangerous entries are cut first, by count × hp × hit.
  - First-area hostiles whose reach (`hostileReach`) exceeds the player's (`playerReach`: unarmed, starting items and items placed in area 1) are removed from the area-1 table. Hostiles a goal or lock needs defeated are kept.
  - Healing consumables heal at least `MIN_HEAL_SHARE` = 25% of max hp. Uniques, reusables and side-effect heals under 10% are left alone.
- **Explorer bands** (`WIN_RATE_TARGETS`) widened at the top: gentle 50–98%, normal 25–85%, hard 12–65%, brutal 5–45%.
  - A world that a new player wins half the time on gentle is one the explorer wins about 90% of the time. The old tops (85/60/40/25%) would have pushed the worlds straight back.
  - The lower limits are unchanged. Per DESIGN §2.5 the upper limits are guard rails, not targets.
- **Demo worlds retuned.** `newPlayerFixes` was applied to all 20 worlds, then the newbie's top killer at the failing level was weakened ×0.85 (hp and damage) and re-checked, until each world cleared its floors by 7 points on fresh seeds. The edits are minimal: only the changed values were rewritten in each file.

| world | weakened (hp and damage ×) |
|---|---|
| corporate-merger-kitchen (en + nb) | odile-greaves ×0.85 |
| fixture-dream | the-erasure ×0.85 |
| fixture-ship | matron-proxy ×0.85 |
| fixture-teen | mags-calloway ×0.85 |
| fixture-western | absalom-vane ×0.72 |
| folk-horror-scarecrow-wedding | gaffer-hob ×0.61 (74 → 45 hp) |
| heist-silent-vault | night-watchman ×0.85, director-stillhart ×0.85 |
| microscopic-root-nodule | kappa-counterfeit ×0.85 |
| alien-twilight-migration | the-gleam ×0.72, shard-skitter ×0.85 |
| detective-sugar-hotel | augustin-pell ×0.85 |
| nb-russetid-bussen | kasper ×0.85 |
| deep-sea-whale-fall | harrow-rig ×0.85 (98 → 83 hp) |

## Result
**New-player gate.** Seeds 5001–5200, so none of the tuning seeds were reused (`--gate`, 8000 runs): all 20 worlds pass.

| world | gentle | normal | | world | gentle | normal |
|---|---|---|---|---|---|---|
| yellow-triangle | 94 | 82 | | ship | 65 | 44 |
| alien | 87 | 47 | | teen | 76 | 42 |
| corporate (en/nb) | 89 | 38 | | western | 75 | 35 |
| yams | 74 | 45 | | folk-horror | 81 | 43 |
| deep-sea | 89 | 48 | | heist | 73 | 46 |
| sugar-hotel | 86 | 43 | | root-nodule | 79 | 32 |
| mimic | 85 | 39 | | noir-tromsø | 68 | 44 |
| dream | 75 | 46 | | russ | 81 | 32 |
| troll | 68 | 38 | | viking (en/nb) | 63 | 47 |

Almost no run ends in area 1 any more: 0–3%, against 14 of 60 heist normal runs after an early cap that kept the watchman.

**Explorer, cautious and talker verdicts.** 100 seeds per bot:

| difficulty | verdict |
|---|---|
| gentle | ok on all 20 worlds (explorer 72–100%) |
| normal | ok on all 20 (explorer 48–84%) |
| hard | ok on all 20 |
| brutal | ok on 19. nb-russetid-bussen is too_hard (explorer 0%), but it was already at 1% before this change. |

There were 0 crashes.

## Remaining
- **Area-1 spawn positions (engine).** The engine places spawn-table hostiles at path distance ≥ 6 from the start (`src/engine/area.ts` choosePos 'anywhere'), so with sight 8 a few can still be in view at the start. The issue's "at most 2 within sight of the start" needs a placement rule in the engine, for example area 0 'anywhere' ≥ sight + 2 from the start. The spawn caps above bound the total to 2–4 guaranteed or possible hostiles, which handles the Yams case (was 7 guaranteed).
- **Brutal russ.** nb-russetid-bussen on brutal is too hard for the explorer (it was already at 1%). Brutal is not gated.
- **Generated worlds.** `src/llm/generate.ts` runs `tuneWorld` with bots `['explorer', 'cautious']`. The new-player fixes now apply to every generated world. The newbie floor only joins the verdict if the pipeline also simulates `'newbie'`, which is the llm owner's call because it costs one more bot's runs.

## Regression tests
- `tests/sim/newbie.test.ts`: the newbie heals at 35% and never uses unknown items, including over whole games. It ignores a far hostile, fights a near one, finishes games and is deterministic.
- `tests/balance/new-player.test.ts`:
  - `newPlayerFixes` caps the first area, removing the most dangerous entries first. It drops outranging hostiles unless a goal needs them, scales heals, is idempotent and is applied by `tuneWorld`.
  - Every demo world already satisfies it.
  - The gate floors and the verdict hook work, and `tools/sim.ts --gate` produces its report.
- Updated for the new bands and values: `tests/balance/{balance,m2-fixes,m2-sim-noise}.test.ts`, `tests/content/{fixtures-m2,m5-difficulty-bands,m2-currency-persuade}.test.ts`.
- The win rates themselves are checked with `npm run sim -- --gate --seeds 200`, which is too slow for vitest.
