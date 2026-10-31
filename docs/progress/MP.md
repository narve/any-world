# MP — Multiplayer edition: definition of done

Date: 2026-10-30. Status: **verified as far as possible without deployment** (MP5 gate, at ba8a140).
Everything that can be checked on the development laptop passes: types, the unit suite, single
player's golden replay, frozen prompts and new-player gate, party sims of 2 to 12 players over all 21
worlds, the room and single-player browser specs, scripted rooms of 8 with network delay and the
mock GM, and a 12-player browser smoke. **Still open:** MP0's exit check and everything that needs the
deployment on the Dell and the VPS (WireGuard, Caddy), the latency playtest through that path, a session
with real people ("was it fast, did we talk"), and the owner decisions listed under "Open".

**Update 2026-10-31:** deployed on 2026-10-28; the server is live at `https://any-game.dv8.no` (D1). The
phone-on-4G check, D2 and D3 are still open. The owner decisions O1–O4 were made on 2026-10-30.

Plan: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md). Milestone notes: [MP1](MP1.md), [MP2](MP2.md),
[MP3](MP3.md), [MP4](MP4.md); hosting: [HOSTING.md](../HOSTING.md).

## How MP5 ran

1. **Playtests and audits** (no tracked files changed): three friends in real browsers (2 desktops and a
   phone, by hand, no autoplay), a phone party (2 touch phones + 3 scripted teammates), a big-room load
   and latency audit (8 and 12 scripted players, up to 3 rooms, one process per player), the GM in play
   (mock GM, plus exactly 15 real Mistral Small calls), a code and security audit of the whole
   `main...multi` diff, and a single-player regression audit against `main`. Headlines below.
2. **Fixes** in two passes: server and GM (`b89b6ba`, recheck `b9539cc`), client (`05692fb`, recheck
   `ba8a140`). What was fixed and what was left is listed under "Fixes" and "Open".
3. **This gate**: the checks under "Gate", then this table.

## Definition of done

Status: **done** = built and verified on the development laptop; **open** = not done, or only
verifiable after deployment or with people. "Watch" notes on a done row name what the real-people
session should look at.

### Plan §1: what we build

| # | Item | Status | Evidence | Needed |
|---|---|---|---|---|
| F1 | Co-op, 2–8 players (12 as a room option), one shared run in a recorded, imported or AI-made world; no PvP | done | Party sims at this gate: 2, 4, 8, 12 players × 21 worlds × 3 seeds, 252 runs, 0 crashes, 0 stuck, 0 timeouts, 0 `illegal`. 8 scripted players in one room (below), and a 12-player browser smoke (2 pages + 10 scripted clients, the host picked 12 in the lobby). Uploaded worlds: `POST /api/rooms/:code/world` through `parseWorld`, a timed trial of the first area and, since `b89b6ba`, of every later area (`laterAreaFailure`). Party-aware world prompt (MP4 G2) | — |
| F2 | No waiting: simultaneous turns; resolve when every active player has acted or at the deadline (1–5 s per room, default 2 s); a player who has not acted waits that turn; nobody acting = the world stands still | done (watch) | `tests/server/rooms-clock.test.ts` rules 1–5, `rooms-room`; the lobby's "Time to decide" select (1–5 s). Big-room audit: rooms of 8/12 with fast players resolved 97 % of turns on "all acted" (median 276/285 ms between turns). With human-paced players before the MP5 fixes, travellers walked at the decider's pace (8 players: median 1150 ms between turns, deadline 15 %). Fix: calm-turn rule 4a (`b89b6ba`). With no hostile in view, travel and wait resolve at the travel cadence and a decide input waits at most 300 ms. Fights keep the deadline by design. At this gate, with think-time bots that only send `decide`: 37–46 % of turns had a hostile in view, so the 2 s deadline still sets p95 (about 2.1 s) in fights | Measure with real people: how often fights fall to the deadline at 4–8 players, and whether it feels slow. The big-room harness is lost (see "Artifacts"), so a re-measure of travellers with human-paced deciders after rule 4a is still to do |
| F3 | Pace (§2.1): click/tap travel keeps its cadence when nothing hostile is in view; reading, chatting or a menu never holds up the others | done locally, open over the real path | Rules 3, 4a and the active set in `rooms-clock`. Big-room audit: all 12 travelling on a 15–40 ms link, 101 ms per step; all 8 travelling at 50–150 ms jitter, 271 ms per step (p95 304). Idle, busy and menu seats never hold a turn (rule 3 tests; "idle is not away", `05692fb`). This gate's 8-player room, fast bots, 50–150 ms jitter: 9.3 turns/s for 120 s | The latency playtest through Dell + VPS + WireGuard. The cadence is bounded by the slowest round trip (one input per turn). Letting travel inputs carry the next steps is a protocol change, not done |
| F4 | Chat is a main feature: bubbles over the speaker on screen, otherwise a line in the side column with name and colour; Enter on desktop, a chat button on phones; typing never triggers game keys or costs a turn; emotes and pings; 100 lines of history, 200 characters, 1 line/s; a "…" bubble while typing | done (watch) | `e2e-mp/mp-chat.spec.ts` (3 tests: Enter, keys stay in the input, bubbles, typing, off-screen column, emotes, pings, rate, 200 characters; the phone sheet with the keyboard up; covered name tags), `mp-exit`, `rooms-room` chat tests. Big-room audit: no line lost (394 sent, 4728 received with 12 players), delivery median 213–218 ms, p95 ≤ 284 ms, typing never held a turn. Three friends: lobby chat carries into the game, bubbles over teammates. MP5 fixes: the dock closes after an emote or ping, history opens at the newest line, private "Here:" lines, opaque phone sheet, tags under another speaker's bubble move or fade (`05692fb`, `ba8a140`) | Real people: "did we talk" |
| F5 | Joining: the host creates a room and shares a link and QR code; open rooms on the start page; name and colour, no accounts; late joiners appear next to the host at the next turn | done | `mp-lobby` (create from a world card, join from the list, name clash, ready, start, mid-run join, host leaves, reload, Leave room; phone by code), `mp-exit` (link and phone code). Three friends: room created 1.8 s after the name sheet; join by link 1.6 s to the sheet and 0.3 s to the lobby; from the phone list 0.3 s; Start to the game screen on all three in 3.1 s. Phone party: game screen 2.1–2.4 s after Start. 12-player smoke: Start to game 2.2 s. MP5: an "N open rooms" button near the top of the phone start page; the offered name is selected on the first click or tap | — |
| F6 | Falling: a second chance per player (Gentle, Normal); a second fall leaves them down, watching a teammate's camera, until a teammate stands next to them for one turn or 20 turns pass; the run is lost only when everyone is down | done (watch) | `tests/engine/party-fall.test.ts`, `mp-party` spectator spec (Hard room, the camera follows, `]` cycles). Seen in the three-friends run: both second chances, a real down ("Watching Ola"), a revive by a teammate in one turn. Sims: 839 downs, 835 back up at 12 players. Phone-party finding (a downed player frozen for about 95 s while every teammate idled) fixed by clock rule 6 (`b89b6ba`): while someone is down and the area is calm, a turn runs every ~1 s. Test "a down player gets up while the teammates do nothing" | Rule 6's idle turns also tick world clocks and hunger while nobody plays; this is noted in `clock.ts`. It belongs with the owner's shared-clock decision (Open O1) |
| F7 | Area exits: the first player at an exit starts a ~10 s countdown; everyone is pulled along and down players arrive standing at half health | done | `tests/engine/party-exit.test.ts`, rule 1 in `rooms-clock` (a countdown turn every 1 s), `mp-exit` (a 40 ms sampler saw the banner on all three screens), `mp-party`. Three friends: about 10 s as designed, the banner clear on every screen. The 2 s wait before the countdown began is fixed by rule 4a (the exit input waits 300 ms at most in a calm area). Big-room: countdown turns 1.0 s each | — |
| F8 | The AI game master runs only on the server, sees the whole party, reads the chat, and its actions go into the shared turn stream | done (watch) | MP4 exit check (`mp4-exit`, `rooms-gm`, `gm-chat`: fiat refused at prompt and room level, restart replays with 0 calls), `mp-gm` in the browser. GM in play (mock): 0 desyncs, nobody ever waited for the GM, the help ceiling held exactly (3 gifts per area at 3 players, 5 at 6), the breaker opened and closed as designed. Real Mistral Small (15 calls): 0.7–3.0 s, in-character answers, nothing harmful. MP5: an addressed line is owed an answer and never dropped (`b89b6ba`, `b9539cc`), hard hourly caps, a voice breaker and debounce. This gate's 8-player room: **10 of 10** `@gm` lines answered (`chat` entries), 21 calls in area 0 (1 voice), 861 ms average | Owner: room call cap and a chat reserve (O2), a canned "the GM is busy" line when the chat call fails (O3). Real people: cost and call rate per hour |

### Plan §2: architecture

| # | Item | Status | Evidence | Needed |
|---|---|---|---|---|
| A1 | Lockstep on the deterministic engine; the server is the authority; a few hundred bytes per turn | done | 0 desyncs in every run of MP5: the big-room audit (up to 36 clients, 30 hash checkpoints per room), GM in play, phone party, three friends (n and turn always agreed), and this gate (8 bots × 2 runs, 12-player smoke). Entries 140–410 B on average (max 954 B). Audit probe: `stepTurn` / `readyPlayers` dry runs never change the replica | — |
| A2 | Desync guard: a state hash every 10 turns, a full snapshot on a mismatch | done | `rooms-exit` faults (snapshots counted), `tests/net/client.test.ts`; `hashState` covers every tile field in party order (audit) | — |
| A3 | Engine version: a hash of the engine source on both sides; an outdated page is refused with a reload toast; old rooms close after an engine change | done | `rooms-exit` version and outdated, `tests/net/version.test.ts`, `mp-lobby` "an outdated server → Reload"; `/api/health.engine` | Check after the first real deploy (Pages and the Dell are deployed apart) |
| A4 | One zod protocol, validated on both sides; invalid or unknown messages dropped and counted | done | `tests/net/protocol.test.ts`; audit: every message checked both ways, server messages inside the client's bounds, frame and size limits. Probe 1: 400 turns of random valid-but-bad actions per demo world never threw | — |
| A5 | Persistence: world, seed, engine version, snapshot and input log under `ANYWORLD_DATA_DIR`; restart replays the log; reconnect tokens | done | `rooms-store`, `rooms-exit` restart (SIGKILL mid-run; MP5 fixed its race), `rooms-gm` (a SIGKILLed GM room replays with 0 calls); atomic writes, torn lines skipped (audit) | Restart on the Dell under systemd (`StateDirectory`) |
| A6 | World for a room: an uploaded world is validated as untrusted; demo worlds from `content/worlds` | done | Upload route with `parseWorld` and the timed trial of every area (`b89b6ba`, a unit test with a fake generator), demo ids path-safe (audit), demo rooms in every spec | — |
| A7 | Limits: 10 rooms, 8 players by default (12 as an option), idle rooms closed after 2 hours | done | `rooms-limits`, `rooms-room`. Big-room: 3 rooms × 12 used 21 % of one core (median, max 71 %), RSS ≤ 196 MB, 337 KB/s out. MP5: same-IP reconnect limits raised (`upgradesPerMin` 40, `socketsPerIp` 36) and a replaced socket ends after 1 s | Behind Caddy: `TRUST_PROXY=1` so per-IP limits see the real client |

### Plan §2.1: turns, pace and talking

| # | Item | Status | Evidence | Needed |
|---|---|---|---|---|
| R1 | Active players: reading, trading, typing, a menu or 10 s idle makes a player inactive; the others' turns resolve without the deadline | done | Rule 3 tests ("an empty active set counts as all acted"), `mp-party` (idle teammates). MP5: idle is no longer shown as "away", and in a run chat no longer counts as activity, so the clock never waits for someone who only chats (`05692fb`) | — |
| R2 | Travel: a step sent every turn; turns where all active players travel or wait resolve at the ~100 ms cadence | done locally, open over the real path | Rule 3 / 4a tests; 101 ms per step with 12 travellers on a good link, 271 ms at 50–150 ms jitter (big-room); three friends: first click-travel step 0.12 s on loopback | Latency playtest through WireGuard + VPS |
| R3 | Safe while talking: a busy player is not attacked for at most 10 turns | done | `tests/engine/party-ai.test.ts`, `party-away`; `mp-chat` (keys stay in the input). Audit note, not a defect: toggling busy each turn keeps a player who does nothing immune (small impact in co-op) | — |
| R4 | The input carries the player's intent; ~1 s turns during an exit countdown | done | the `input` message's `intent` (`src/net/protocol.ts`), rule 1 tests, countdown turns 1.0 s (big-room) | — |
| R5 | Area entry: map generation never counts against a deadline | done (watch) | Rule 2 (area hold) tests; big-room: generation blocks the event loop 338 ms at 8 players and 475 ms at 12 (within the plan's ~0.6 s), hold 0.5–1.3 s, never timed out, client apply 0.28–1.04 s | Phone apply times with real people. A worker thread is a later improvement (plan §3) |
| R6 | NPC conversations per player, never pausing anyone; nearby players see the NPC's lines as bubbles | done | `tests/server/rooms-dialogue.test.ts`, `tests/engine/party-npc.test.ts`, `mp-gm` (the NPC line as a bubble for the nearby teammate, then the voiced line) | — |
| R7 | How many players: map growth per player, balance tested by bots up to 12, design for 8, allow 12 with a browser smoke | done (watch) | Sims at this gate (all 21 worlds × 3 seeds): fell 17 % / 27 % / 39 % / 47 % at 2 / 4 / 8 / 12; 12 players won 94 % (4 losses to world time limits: the Yellow Triangle's varnish ×3, Lowmoor's speech once). The 12-player browser smoke passed (below) | Crowding at 12 seen in the smoke: on the phone the off-screen teammate markers stack on top of each other at the screen edge, and on the desktop the party strip is cut after 9 chips. Party difficulty at Normal (MP1's open question) is for the real session |

### Plan §3: exit check of every milestone

| # | Milestone exit check | Status | Evidence | Needed |
|---|---|---|---|---|
| MP0 | The single-player game runs on the laptop, reachable over HTTPS from a phone on 4G | **open** | Code done (`fd6dfb1`): systemd unit, `scripts/deploy.sh`, `/api/health`, host access code, `ALLOWED_ORIGINS` / `ANYWORLD_SERVER_URL`, the Node version guard. `e2e/modes.spec.ts` 15/15 at this gate (static build, backend, production, access code, Pages + server URL) | Deployed 2026-10-28 on the Dell and the VPS (WireGuard, Caddy, DNS for `any-game.dv8.no`; `any.dv8.no` waits for the merge to `main`). Left: open it from a phone on 4G (not yet confirmed) |
| MP1 | Engine tests; bots in 2–4 player runs over all 21 worlds with 0 crashes and no soft-locks; a full run with 12 bots, turn times reported | done | MP1 gate (`334d269`): 756 runs, 0 crashes; 12 players: engine median 2 ms, p95 ~8 ms. Again at this gate, 2/4/8/12 players: 252 runs, 0 crashes, 0 stuck, 0 timeouts, 0 `illegal` | — |
| MP2 | Server tests: 4 scripted clients chatting and playing, kill and restart mid-run, a new engine version closes rooms with a toast, an outdated client refused with a reload toast, disconnect and reconnect, packet delay and loss | done | MP2 gate (`552639d`); `rooms-exit` 7/7 inside this gate's full vitest run (with the MP5 restart-race fix) | — |
| MP3 | Playwright with 3 browser contexts (desktop and phone) playing one run together and chatting | done | MP3 gate (`ed76bc4`, 3/3 runs); `mp-exit` passed again at this gate (part of the 12/12 room specs) | — |
| MP4 | GM checks still refuse fiat; demo rooms play without AI | done | MP4 gate (`12af18d`): exit check 53/53, the live Mistral smoke; `mp4-exit`, `rooms-gm` and `gm-chat` pass in this gate's full run | — |
| MP5 | Review, playtest and fix rounds; a latency playtest through the real exposure path; a short session with real people, judged on "was it fast, did we talk"; the DoD table in `docs/progress/MP.md` | **partly open** | Review, playtests and two fix rounds done (above); this table | The latency playtest through Dell + VPS + WireGuard, and the session with real people. The deployment they needed is live since 2026-10-28 |

## Gate (MP5, 2026-10-30, at ba8a140)

Verified, not built. No product or test code changed. Throwaway drivers lived in `/tmp/mp5gate` and
an untracked `e2e-mp/_mp5gate/` folder, and both were deleted afterwards. All servers ran on 5630/8930
(and 5631/8931, 5632–5635/8935 for the browser specs) and were stopped by process group.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean |
| Unit tests | `npx vitest run` | **201 files, 2394/2394 passed** (248 s), first run; no load-sensitive rerun needed |
| Golden replay, frozen prompts | `tests/engine/golden-replay.test.ts`, `tests/llm/frozen-prompts.test.ts` | 12/12; both files unchanged since `02f718c` / `ab23cbd` |
| New-player gate | `npx tsx tools/sim.ts --gate --seeds 40 --jobs 6` | **21/21 worlds pass**, 1680 runs (204 s, alongside the party sims). `src/engine` changed since the MP4 gate (`05692fb`: optional `LogMessage.pid`) |
| Party sims | `npx tsx tools/sim.ts --party-sizes 2,4,8,12 --seeds 3 --bots explorer,cautious,talker --jobs 8` (21 worlds, Normal) | **252 runs: 0 crashes, 0 stuck, 0 timeouts, 0 `illegal`** (exit 0, 452 s). Table below |
| Room specs | `E2E_MP_PORT=5630 E2E_MP_API_PORT=8930 E2E_MP_GM_PORT=5631 E2E_MP_GM_API_PORT=8931 xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts` | **12/12 passed** (8.0 min): `mp-chat` 3, `mp-exit` 1, `mp-gm` 1, `mp-lobby` 3, `mp-party` 2, `mp-review-fixes` 2. The ECONNRESET lines are the Vite proxy while the "server down" test stops its server. These specs run with `calmFlow: false` (their timing), so rule 4a is covered by unit tests and the scripted rooms, not in the browser specs |
| Single player e2e | `e2e/play.spec.ts` (a temporary config on 5635/8935, removed); `MODES_PORT=5632 … e2e/modes.spec.ts` | **4/4** (25 s), **15/15** (2.0 min) |
| 8-player scripted room | `server/dev.ts` on 5630/8930, default room timing, `ANYWORLD_TEST_GM` (scripted answers, 300–1500 ms latency); 8 `ScriptedClient`s (explorer, cautious, talker, newbie) over `FaultyChannel` with 50–150 ms each way, a chat line every ~40 entries, an `@gm` line every 12 s; fixture-western, 120 s | **1122 turns (9.3 turns/s), all 8 on one hash**, 0 desyncs, 0 snapshots, 0 reconnects, 0 faults. Server time between turn entries: p95 316 ms, max 1387 ms (area entry). 224 chat lines and every client's history full (100). GM entries: intro 1, idle 3, chat 10, region 12, milestone 4, low_hp 1, area_enter 1; **10/10 `@gm` lines answered**. Server stats: area 0 21 calls (1 voice), 861 ms average. Refusals 5–22 per bot (teammate races) |
| 8 players, harsh network | the same, 60 s, 100–300 ms each way, a 600 ms stall about every 300 frames, a dropped socket about every 1500 frames, 3 % lost inputs | 290 turns (4.8/s), p95 620 ms, max 2230 ms; 4 reconnects, 0 snapshots, 0 desyncs, one hash; 4 of 5 `@gm` lines answered (the fifth was said as the run stopped) |
| 8 players, think-time bots | the same as the first room, 90 s, each decision immediate (60 %), 0.3–1.5 s (35 %) or 2.5–4 s (5 %); `ScriptedClient` always sends intent `decide` | 1.5–2.3 turns/s, median 160–204 ms, p95 2.1–2.2 s (the deadline). 37 % of turns had a hostile in view (3 players: 46 %). Default timing and `calmFlow: false` came out alike (1.45 / 1.48 turns/s). These bots never travel, so this is not a measure of rule 4a for travellers (see F2) |
| 12-player browser smoke | dev server on 5630/8930 as above; a desktop host page (sets "Players at most" 12 in the lobby), a phone page (390×844, touch) joining by link, 10 `ScriptedClient`s at 50–150 ms; the in-page autoplay on both pages, 150 s | **passed** (2.7 min): Start to game 2.2 s, roster 12, n 646 (area 1), both pages and all 10 bots on one hash, 0 desyncs, 0 snapshots, autoplay 247 / 254 actions with 0 refusals, 0 page errors, no horizontal scroll on the phone. Screenshots `test-results/mp5-gate/play-12-{desktop,phone}.png`, `lobby-12-desktop.png` |

Parties at this gate (21 worlds × 3 seeds, Normal):

| party | runs | won | lost | fell | downs | up (by a teammate) | avg turns |
|---|---|---|---|---|---|---|---|
| 2 | 63 | 100 % | 0 | 17 % | 15 | 12 (7) | 646 |
| 4 | 63 | 100 % | 0 | 27 % | 96 | 93 (62) | 693 |
| 8 | 63 | 100 % | 0 | 39 % | 343 | 340 (253) | 861 |
| 12 | 63 | 94 % | 4 (time limits) | 47 % | 839 | 835 (654) | 1054 |

## MP5 playtest headlines

Every playtest ran on the development laptop over loopback. None used the real exposure path.

- **Three friends** (Kari desktop, Ola desktop by link, Siv on a 390×844 touch phone from the room
  list; real clicks, keys and taps, no autoplay; default timing, offline GM; "The Last Yellow
  Triangle"). Two area changes, chat throughout (Enter, the phone sheet, emotes, a Help ping), fights,
  two shared level-ups, a GM choice, a reload in region 2 that got back the same seat, both second
  chances, a real down and revives both ways. Lost in region 3 at turn 490 ("Varnished in Place"). Play
  again put all three in the new run's first area in 6.2–7.3 s. Numbers: room created 1.8 s; link join
  1.6 s + 0.3 s; phone list join 0.3 s; Start to game 3.1 s; first click-travel step 0.12 s; exit
  countdown ~10 s. No page errors, and the replicas always agreed. Good: the countdown banner, the down
  banner, bubbles over teammates, the phone ping marker, lobby chat carried into the game, quick play
  again. Hurt (fixed unless noted): "away" tags everywhere; the dock left open after an emote; chat
  history at the oldest line; "Here:" lines for everyone; identical-looking characters; tags and bubbles
  over teammates; the phone room list below the fold; a per-turn world clock (varnish) that drains much
  faster in a party with no shared warning (**open**, O1). SwiftShader at ~2 fps: frame rate and reload
  time could not be judged.
- **Phone party** (two touch phones 390×844 and 360×800 + 3 scripted teammates, mock GM, 1.5 s
  deadline). 7 runs, the last clean (6.5 min, autoplay 672 + 588 inputs, 0 faults, no horizontal
  scroll). Game screen 2.1–2.4 s after Start; a teammate's bubble on the other phone in ~380 ms.
  Problems: a downed player frozen ~95 s while teammates idled (fixed, rule 6); an `@gm` line unanswered
  inside the 20 s window in 3 of 3 runs (fixed, owed answers); "Meanwhile" cards over the chat button
  and hotbar (the race toasts are now quiet; the cards themselves are **open**, client); "away" at run
  start (fixed); the sheet opening at the oldest line with a short history (fixed); small tap targets
  and the prefilled name (fixed); the top HUD with the keyboard up and the tall spectator banner on
  360 px (**open**, low).
- **Big room** (no browser; real server process, mock GM, one process per scripted player, 50–150 ms
  jitter, machine load ~20). Fast rooms of 8/12: 97 % of turns on "all acted", felt wait median
  278/291 ms. Human-paced rooms of 8/12: felt wait per travel step 862/1050 ms median, p95 ~2.2 s, so
  **"nobody waits" failed at 8–12** before rule 4a. All travelling: 271 ms per step at 50–150 ms, 101 ms
  at 15–40 ms. Map generation stall 338/475 ms (8/12). Server CPU one room 3–13 % of a core, 3 × 12
  rooms 21 % median; RSS ≤ 196 MB; traffic 30–343 KB/s out. 0 desyncs over all runs, no chat line lost,
  chat delivery median ~215 ms. Shared-IP reconnect after a half-open drop took 32–53 s for 8 of 12
  (fixed: limits raised, replaced sockets end after 1 s).
- **GM in play** (mock, and 15 real Mistral Small calls). Mock: turn latency unaffected by the GM
  (p99 ~770 ms in every case, also with a provider slower than the timeout and with 50 % server
  errors); the breaker opened and closed as designed; the help ceiling held. Before the fixes only 2 of
  6 addressed lines were answered (throttle windows; fixed: owed answers). Real: 9 calls 0.7–3.0 s
  (~1.4 s average), 6 voice calls aborted (fixed: debounce, no aborts, own breaker), answers in
  character, nothing harmful, the room's 15-call cap let a 16th call through (fixed: hard caps). About
  9 calls a minute for 3 players: the 400/h room cap would be reached in under an hour (**open**, O2).
- **Audit** (code and security of `main...multi`, ~38.6k added lines): 6 confirmed problems, none high
  (a flaky restart test and small bookkeeping and limit bugs; all fixed in `b89b6ba`). Random bad actions
  never threw; replicas are never changed by dry runs; the largest welcome for 12 players is ~230 KB
  against a 4 MB send buffer; validation, path safety, atomic writes, redaction, shutdown order and the
  dev-only autoplay all checked out.
- **Single player** (multi vs `main`): no regression. Same 146 turns on fixture-ship seed 4 on both
  branches, key-to-turn 17–18 ms vs 19 ms, travel step the same, save and continue fine, no room UI in a
  solo game. The static Pages build without a server downloads the same bytes as `main`. With a server
  the room flow chunk (~27 KB gzip) loads even for a solo game (**open**, low). `mobile.spec` touch-only
  runs are flaky under load and pass alone.

## Fixes (MP5)

`b89b6ba` and `b9539cc` (server and GM), `05692fb` and `ba8a140` (client). In short:

- **Pace**: calm-turn rule 4a (travel and wait at the travel cadence, decide waits ≤ 300 ms with no
  hostile in view; `RoomTiming.calmFlow`); rule 6 (a down player is not frozen while teammates idle in a
  calm area); the exit input no longer waits for the deadline in a calm area.
- **Chat and GM**: an addressed line is owed an answer (one chat request at a time, quoting every line
  since), a seat's own follow-up is owed too; the seat window cut to 20 s; hard per-call cap checks;
  voice debounce, no aborts and its own breaker; first-idle once per area in a party; the chat brief
  asks the GM to reply to the line; stats flushed at shutdown.
- **Presence**: idle is not "away" (away only for a dropped connection); chat does not count as
  activity during a run; typing no longer makes the roster "busy" (lighter roster traffic).
- **Client**: the dock closes after an emote or ping; Esc closes it; history at the newest line;
  private "Here:" lines (an optional `LogMessage.pid`, party only); one quiet "Someone got there first."
  at most every 8 s for teammate races; seat-coloured outlines and tags that move out of the way; phone
  lobby order, an "N open rooms" button, the name selected on the first click or tap, larger tap
  targets, an opaque chat sheet, the emote and ping row on one scrolling line; the room list backs off
  while the server is down.
- **Server limits and hygiene**: shared-IP reconnect limits; a replaced socket closes after 1 s; the
  2-minute timers kept on a half-open reconnect; GM request ids cleaned up; every area of an uploaded
  world trial-generated; `SeatId` up to 9 digits; the `rooms-exit` restart race and the mapgen timing
  assert (now in thread CPU time) fixed.

## Open

Needs the deployed server or people:

- **D1. Deploy** on the Dell and the VPS (HOSTING.md) — **done 2026-10-28**: WireGuard tunnel, Caddy
  with HTTPS, `TRUST_PROXY=1`, the server live at `https://any-game.dv8.no`. Still to do: MP0's check
  (HTTPS from a phone on 4G; not yet confirmed), and after `multi` is merged into `main`, the Pages
  build at `any.dv8.no` with `ANYWORLD_SERVER_URL` and `ALLOWED_ORIGINS` on the server
  (HOSTING.md §8, steps 1 and 6).
- **D2. Latency playtest through the real path**: travel step time (all travelling, and with a decider
  in a fight), felt wait for a decided move, chat delivery, reconnect after a network change on a phone,
  area entry on a phone.
- **D3. A short session with real people** (3–5 players, desktop and phones): "was it fast, did we
  talk". Also: GM calls per hour and cost (O2), whether fights at the 2 s deadline feel slow, party
  difficulty at Normal, crowding at 8+, reload time and frame rate on real phones.

Owner decisions:

- **O1. Per-turn world clocks in a party** — **decided 2026-10-30: they scale** (`PARTY_SCALING.worldClock`
  0.06 per extra player: every-N rule triggers, per-turn drains and `turn` conditions; `tests/engine/party-clock.test.ts`).
  Was: (varnish-style lose conditions drain faster with more players
  and rule 6's idle turns also tick them): scale per party, count per player action, or keep the rule
  and add a party warning banner (client). Changes engine rules, so the golden replay and the gate apply.
- **O2. GM call budget** — **decided 2026-10-30: 400 calls per room per hour for now, no chat reserve;
  revisit after the real-people session.** Was: `ANYWORLD_GM_ROOM_CALLS_PER_HOUR` (400) and whether chat gets a reserve;
  measured: ~9 calls/min for 3 human-paced players, ~31/min for fast bots (upper bound).
- **O3. A failed chat answer** — **decided 2026-10-30: silence is fine.** Was:: today a failed call, an open breaker or a reached cap means silence for
  that line; an out-of-character "the GM is busy" line is a wording and UX choice.
- **O4. Party difficulty at Normal** (from MP1): bot parties win ~100 % at 2–8. **Decided 2026-10-30:
  keep it for now, but bosses get tougher with the party: `uniqueHp` 0.8 → 1.0, `uniqueDamage` 0.1 → 0.2
  per extra player.**

Not done, could be done locally later:

- Travel inputs carrying the next planned steps (removes the round-trip bound on the travel cadence;
  protocol change).
- Client: "Meanwhile" cards over the phone chat button and hotbar; the party warning banner for a shared
  clock (with O1); a compact spectator banner on 360 px; the top HUD with the keyboard up; health bars
  over name tags; crowding at 12 (stacked edge markers on the phone, the desktop party strip cut after 9
  chips); opening the new-world form from the lobby; loading the room flow chunk on demand.
- A re-measure of travellers with human-paced deciders after rule 4a (a `ScriptedClient` option for
  think time and travel intent would make this a repeatable tool instead of a throwaway harness).
- Map generation in a worker thread (plan §3, "possible improvements").

## Artifacts

The playtest screenshots named in the playtest reports (`test-results/mp5/three-friends/`,
`test-results/mp5/phone-party/`, `test-results/mp5-big-room/`, `test-results/sp-audit/`) and the MP3
gate's copies (`test-results/mp3-gate/`) **no longer exist**. Playwright clears `test-results/` at the
start of every run, and the later e2e runs (the fix passes' and this gate's) removed them. The folder is
git-ignored, so they cannot be restored. Their findings are kept in this note. Playtest evidence should
go outside `test-results/` from now on. This gate's own screenshots and room-run outputs are in
`test-results/mp5-gate/` and will be cleared the same way by the next Playwright run.
