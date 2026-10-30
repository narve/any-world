# MP1 — Engine: parties: progress note

Date: 2026-10-27. Status: **MP1 exit checks met** (engine and bots only; no room server, no
WebSocket, no lobby or chat UI: those are MP2 and MP3). Design and the per-step "as built" notes:
[MP1-DESIGN.md](MP1-DESIGN.md). Plan: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3.

## What MP1 built

| Step | Commit subject | Content |
|---|---|---|
| B0 | golden replay test | six single-player bot runs with format-neutral fingerprints, taken before any change |
| B1 | party data model v2 and hashState | `players`, `party`, `purse`, `partyRules`; knowledge, pending choice, fog, second chance and `lastHarm` per player; accessors (`me`, `playerOf`, `withPlayer`…); saves v2 (fog run-length coded); `hashState` |
| B2a | party turn API | `runTurn` / `stepTurn` / `readyPlayers`, refusals by reason, busy input, per-player upkeep and FOV, swap with a teammate, one dialogue per NPC, shared purse and XP, `createGame({ players })`, `addPlayer`, `runParty`, timing hooks |
| B2b | AI among players, falling and revive, party goals | sticky hostile targets, busy players not attacked (10 turns at most), per-player perception; second chance per player on Gentle/Normal, down players, revive by a teammate (1 turn) or alone (20 turns), the run lost only when everyone is down; goals and locks quantified per condition leaf |
| B3 | area transitions, party scaling | exit countdown (`partyRules.exitCountdownTurns`, default 5 turns), early move when everyone is at the exit, everyone pulled along (down players arrive standing); `PARTY_SCALING` for map area, hostile numbers and hp, items, GM budget and actor cap |
| B4 | party sim tool, party-aware bots, tuning, docs | below |

### B4

- **`tools/sim.ts --party <n> / --party-sizes 2,3,4 / --timing`.** Player *i* plays bot `(i + seed)
  mod |--bots|`, so seeds rotate who leads and who pairs up. A summary row per party size: won / lost /
  stuck / crash / timeout, average turns, **fell** (share of players who fell at least once: a second
  chance used or down), downs, revives (helped by a teammate), refusals by reason, areas reached.
  `--timing` injects `performance.now` and prints mean / p95 / max for the whole party turn, the
  engine's share and the bots' share, plus the engine split (turn, world, ai, fov). Exit code 1 on a
  crash or an engine anomaly (`illegal` refusal, invariant break). `--gm` and `--gate` stay single
  player. Code: `src/engine/sim/party.ts` (`summarizeParty`, `formatPartySummary`, `timeStats`,
  `partyBots`; `PartyResult` gains `downs`, `revives`, `helpedRevives`, `secondChances`,
  `playersFell`, `timing.engineMs`).
- **Party-aware bots** (`src/engine/sim/bots.ts`, `view.ts`). Every new behaviour returns at once in a
  party of one, so single-player bot games are unchanged (golden replay and gate below):
  - goals and locks are planned the way the engine checks them (`evalParty`: the packs count
    together), so a bot no longer hunts for an item a teammate carries. This was the viking area-2
    stall known since B2a;
  - **hand-over**: an item whose use sets a wanted flag or counter and needs other items in the
    user's pack (viking: recite the Law-Knot holding all three oath-rings) makes its holder the
    collector; teammates walk the needed items over and drop them next to the collector, who wants
    them and picks them up. Only once the rest of the use condition holds for the collector (the
    right area), so nothing is dropped where the party may leave it behind. This was the viking
    area-3 timeout;
  - **revive**: walk next to a down teammate nobody is helping (path cost ≤ 40) and stand there a turn;
  - **gather**: walk to the exit while the countdown runs (the party then moves on early);
  - path costs +3 on a standing teammate's tile (walking into them swaps places, which spoils their
    planned action: `stale` refusals fell by about two thirds), and a refused move that was only
    `contested` / `stale` no longer makes the bot give up on its target.
- **Bot fix for single player too:** a resource in a `stat … gte` lose condition (the yellow
  triangle's varnish) counts as rising danger: terrain that raises it is a hazard to path around, and
  a known item that lowers it is used past 70 % of the limit. Before, the bots treated "+1 varnish"
  terrain as a refill. Only that world has such a lose condition.
- **Engine fix:** a player downed by their own action (a self-harming item) was charged the action's
  energy after the down (energy −100, an invariant break on Brutal). `party.ts` now skips the cost
  for a down player. Test in `tests/engine/party-fall.test.ts`.
- **Tuning** (`src/engine/difficulty.ts`): `hostileCount` 0.35 → 0.65, `hostileHp` 0.15 → 0.3 (other
  factors unchanged). See "Tuning" below.

## Exit checks

| Check | Result |
|---|---|
| 1. `npx tsx tools/sim.ts --party-sizes 2,3,4 --seeds 10 --bots explorer,cautious,talker --jobs 15`, all 21 worlds, Normal | **630 runs: 0 crashes, 0 stuck, 0 timeouts, 0 invariant errors, 0 `illegal` refusals.** Won 209/210 (2 players), 209/210 (3), 210/210 (4). Other refusals: contested 4991 / 3054 / 6192, stale 4401 / 5604 / 8121, `area changed` 10 / 2 / 0, `not ready` and `down` 0 |
| 1b. Same on Brutal | 630 runs, 0 crashes, 0 stuck, 0 invariant errors (after the energy fix; before it 6 runs broke the invariant), 0 `illegal`. Won 152/210, 205/210, 203/210 |
| 2. `npx tsx tools/sim.ts --world content/worlds/fixture-western.json --party 12 --seeds 1 --timing` | won, 0 crashes, no soft-lock; turn times below |
| 2b. `--party 12 --seeds 2`, all 21 worlds | see "12 players" below |
| 3. `npx tsx tools/sim.ts --gate --seeds 40 --jobs 15` | all 21 worlds pass; identical to before B4 except abstract-yellow-triangle (gentle 95 % → 98 %, normal 85 % → 90 %, from the varnish fix) |
| 3b. Golden replay (`tests/engine/golden-replay.test.ts`) | unchanged |
| `npx tsc --noEmit -p .` / `npx vitest run` | clean / **163 files, 2008 tests, all pass** |

### 12 players

fixture-western, 12 bots (explorer, cautious, talker in turn), `--timing`, one job on an idle
16-core machine; both seeds won (1099 and 1130 rounds, maps up to 91×65):

| seed | whole party turn: mean / p95 / max | engine: mean / p95 / max | bots: mean / p95 / max | engine per turn: world / ai / fov |
|---|---|---|---|---|
| 1 | 16.2 / 33.8 / 290 ms | **3.5 / 8.3** / 260 ms | 12.7 / 29.0 / 46 ms | 1.90 / 1.48 / 0.98 ms |
| 2 | 15.2 / 32.1 / 333 ms | **3.0 / 7.5** / 292 ms | 12.1 / 29.1 / 56 ms | 1.48 / 1.08 / 0.91 ms |

The max is the turn that enters an area (map generation for 12 players). `--party 12 --seeds 2` over
all 21 worlds: 42 runs, **0 crashes, 0 stuck, 0 timeouts, 0 invariant errors, 0 `illegal`**; 40 won,
2 lost to time limits (the yellow triangle's varnish and fixture-western's 1400-turn contract: 12-player
runs take about 1.6× the rounds), fell 54 %.

**The 20 ms budget is for the engine.** The p95 over 20 ms for the whole party turn is the 12 bots'
own decision time (path fields over the map, about 1 ms per bot). In play, a turn's inputs come from
people; the server and every client run only the engine on them (`stepTurn` with every player's
action), which is the "engine" row. The bots are a test stand-in and are reported apart.

## Tuning

A party almost never loses on Normal: it is lost only when everyone is down at once, every player has
a second chance and teammates get each other up. Win rate is therefore no use as a target; the
measure is **fell**, the share of players who fell at least once. Single player for comparison: the
same bots win 65 % on Normal (407 of 630) and 47 % on Hard.

| `hostileCount` / `hostileHp` | fell, 2 / 3 / 4 players | downs, 2 / 3 / 4 | avg turns, 2 / 3 / 4 |
|---|---|---|---|
| 0.35 / 0.15 (B3) | 14 % / 10 % / 8 % | 41 / 36 / 31 | 635 / 568 / 628 |
| 0.5 / 0.25 | 22 % / 17 % / 17 % | 95 / 97 / 156 | 671 / 591 / 654 |
| **0.65 / 0.3 (chosen)** | **20 % / 23 % / 24 %** | 70 / 132 / 232 | 658 / 617 / 678 |

With the B3 numbers a larger party was safer per player (hostiles grew more slowly than the
party). With 0.65 / 0.3 a player's risk is about the same whatever the party size and the runs are
no longer. At 12 players this means 8.15× the hostiles at 4.3× hp on 2.65× the map area; the actor cap
(60 + 10 per extra player) bounds it.

## Known limits

- **Normal is very safe for a party** (≈100 % bot wins). That follows from the owner's rules (a second
  chance per player, revive, loss only when everyone is down). Hard and Brutal give the tension
  (Brutal: 72 % for 2 players, 97–98 % for 3–4). Whether Normal should be harder for parties is an owner
  question; the levers are `PARTY_SCALING` and `partySecondChance`.
- **12 players are harder per player than 2–4** (fell 54 % against 20–24 %) and their runs are about
  1.6× longer, which costs worlds with a turn or time limit. The factors are linear in the party
  size; if 8–12 player rooms feel crowded in MP5, flatten `hostileCount` above some size.
- **Two players on Brutal** lose 28 %: two downs at once end the run, and the scaling does not change
  that.
- **Bots** do not trade items in general, only hand over what a goal item's use condition needs; they
  do not follow each other (they explore apart, which the runs did not need); `contested` and `stale`
  refusals are still common (thousands per 210 runs): two bots aiming at the same tile or target. Each
  is a lost turn for a bot, not an engine fault.
- **Per-player world rules stack:** a rule with player triggers (yellow triangle: "the Painter's brush
  sweeps the area around you" every 80 turns) fires for every player, so a party standing together
  gets several coats. MP1 keeps it (rules are per player); the bots now step out of them.
- **GM in party runs:** `runParty` does not feed scripted GM actions (`--gm` is single player); the
  GM prompt still quotes a budget of 10 per area (MP4).
- **Client:** single player only, as planned (no multiplayer UI in MP1). The single-player browser
  smoke passed at the gate (below).

## Gate (final verification, 2026-10-27, at 1d21f09)

Run by the MP1 gate on a 16-core machine, nothing changed in the code.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean |
| Unit tests | `npx vitest run` | 163 files, 2010 tests: 2009 passed, 1 failed: the load-sensitive timing assert in `tests/mapgen/generators.test.ts` ("organic / large", sims ran alongside); that file alone: 67/67 pass |
| New-player gate | `npx tsx tools/sim.ts --gate --seeds 40 --jobs 6` | **21/21 worlds pass** (1680 runs, 147 s). Closest to a floor: both viking worlds at Normal 25 % (floor 25 %); the Gentle minimum is Mørketidsis 65 % (floor 50 %) |
| Parties of 2, 3, 4 | `npx tsx tools/sim.ts --party-sizes 2,3,4 --seeds 12 --bots explorer,cautious,talker --jobs 8`, all 21 worlds, Normal | **756 runs: 0 crashes, 0 stuck, 0 timeouts, 0 anomalies, 0 `illegal` refusals** (exit code 0) |
| 12 players, one world | `npx tsx tools/sim.ts --world content/worlds/fixture-western.json --party 12 --seeds 1 --timing --jobs 1` | won in 1099 rounds (1225 party turns), 3 areas, 0 crashes, no soft-lock, 0 anomalies |
| 12 players, all worlds | `npx tsx tools/sim.ts --party 12 --seeds 2 --jobs 8` | 42 runs: 0 crashes, 0 stuck, 0 timeouts, 0 `illegal`; 40 won, 2 lost (both the yellow triangle's varnish limit), fell 57 % |
| Browser smoke | dev server (`PORT=8787 ANYWORLD_CLIENT_PORT=5173 npx tsx server/dev.ts`), `xvfb-run -a npx playwright test e2e/play.spec.ts e2e/mobile.spec.ts --reporter=line` | 11 of 12 passed in the first run; `pixel7-portrait: touch-only play of fixture-western` stopped after 64 taps (it needs > 87: the game left `playing` early); rerun alone it passed. A flaky end-of-game condition in the mobile bot, not an MP1 regression |

Win rates by party size (Normal, 21 worlds × 12 seeds):

| party | runs | won | lost | fell | downs | revives (by a teammate) | avg turns |
|---|---|---|---|---|---|---|---|
| 2 | 252 | 250 (99 %) | 2 (Trolldirektoratet, seeds 7 and 10) | 19 % | 83 | 75 (55) | 664 |
| 3 | 252 | 252 (100 %) | 0 | 24 % | 193 | 190 (138) | 616 |
| 4 | 252 | 252 (100 %) | 0 | 24 % | 283 | 276 (196) | 683 |

12-player turn times (fixture-western seed 1, ms per party turn, `performance.now` injected; the
median from a separate run of the same game through `runParty` with the same clock, since
`--timing` prints mean / p95 / max):

| | median | mean | p95 | max |
|---|---|---|---|---|
| engine (`stepTurn` with all 12 inputs) | 2.0–2.1 | 2.8 | 7.7–8.7 | 249–572 |
| whole party turn (engine + 12 bots) | 13.6–13.7 | 12.5 | 22.7–30.1 | 279–613 |

The max is the turn that enters a new area (map generation for 12 players, maps up to 91×65); every
other turn stays far below the 20 ms engine budget. The spread between runs is machine noise.

## Known gaps for MP2

- **No room server yet:** the engine has the pieces MP2 needs (`stepTurn` with every player's input,
  `readyPlayers`, refusals by reason, the busy input, `addPlayer` for late joiners, `hashState` for
  desync checks, saves v2), but the turn deadline, the travel cadence (~100 ms) and mapping seconds to
  turns for `exitCountdownTurns` (5 turns by default; the plan's 10 s) are the server's job.
- **Area entry is a spike** at 12 players (up to ~0.6 s for map generation): the room should not count
  that against anyone's turn deadline, or pre-generate.
- **Roster data** (names, colours, who is the local player) is not in the engine; the client reads the
  local player as the lead (`leadPlayer`), which MP3 must replace with the joined player's id.
- **Busy** comes from the input (dialogue, trade, typing); a typing flag has to come from the chat in
  MP3. Hostiles leave a busy player alone for 10 turns at most.
- **GM** targets the lead player and keeps a budget quote of 10 per area (MP4).
- **Balance:** Normal is near-certain for bot parties (owner question, levers `PARTY_SCALING` and
  `partySecondChance`); 12 players fall more often than 2–4 (57 % against 19–24 %) and their runs
  take longer, which costs worlds with a turn limit (the yellow triangle).
- **Flaky e2e:** the mobile touch-only fixture-western spec can end early; worth a look when the
  client is touched in MP3.
