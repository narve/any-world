# MP3 — Multiplayer client: progress note

Date: 2026-10-29. Status: **MP3 done: exit check met and verified by the MP3 gate** (below) (lobby, rooms on the start page, the client playing its
own player, the party view, the turn indicator, the spectator camera, chat with bubbles, emotes and
pings, notices; en and nb). Design and the per-step "as built" notes: [MP3-DESIGN.md](MP3-DESIGN.md).
Plan: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3. Single player plays as before (the
characterization recording, the golden replay and the new-player gate are unchanged, below). Rooms still
run the offline canned director as their game master; the AI game master in rooms is MP4.

## What MP3 built

| Step | Commit subject | Content |
|---|---|---|
| D1 | net additions and client plumbing (no UI) | protocol and server for `ready`, `profile`, `world`, the difficulty option, `ping`, the `room` broadcast; typing keeps a dialogue's busy; test switches `ANYWORLD_TEST_SEED` / `ANYWORLD_TEST_LIMITS` (never under `NODE_ENV=production`); `RoomClient` per-entry `steps`, `catchUp`, `stopReason`, `ready()` / `profile()` / `pickWorld()` / `setOptions()` / `ping()`; `room/config.ts`, `api.ts`, `profile.ts`, `qr.ts` (`qrcode-generator` 1.4.4); `?room=` boot route; ~105 en/nb keys |
| D2 | single-player characterization recording; room session core (DOM-free) | a sim bot through `uiAction` over 6 seeds recorded first and kept byte-identical; `perspective(state, pid)`; `GameSession` split (`pid`, `absorbStep`, `absorbGm`, `nextTravelAction`, chain helpers); `RoomSession` (state = this player's perspective, assigned in absorb only; dry run on the replica; one input per turn; chains as one input; per-entry absorb; late join; spectator follow); `ChatModel`; the in-memory room harness |
| D3 | controller room mode, start page rooms, lobby, notices | `RoomLink` (presence, seat tokens, chat model, notices), `GameController` room mode (serial renderer syncs, entry-driven travel, `cameraState`), `RoomFlow` (lazy: create, join by list / code / link, the name sheet, welcome by phase, relaunch per run, end-screen room block and play again, "Leave room"), `LobbyScreen` (roster, ready, world picker, options, GM line, share link, QR), toasts with actions, the reconnect banner, `e2e-mp/` config, `__anyworld.room` |
| D4 | in-game party and chat UI (+ start bundle relief) | ring colours and `setFollow` in the renderer, `PartyOverlay` (name tags, bubbles, "…", pings, edge arrows, HUD-aware placement), party strip, turn pill ("2 of 3 acted", "Kari is deciding"), banner (reconnect > spectator > exit countdown), spectator camera with `[` / `]` and the pill, `ChatPanel` (desktop dock, phone sheet and chat button, lobby and end screen inline), log-ticker lines, emotes, pings, Enter / `/` / Shift+Enter, rate feedback; the world balance step moved out of the start bundle |
| D5 | exit check, autoplay, notes | in-page autoplay (dev and test builds), `e2e-mp/mp-exit.spec.ts`, the fixes below, this note |

## Exit check

Plan §3, MP3: "Playwright with 3 browser contexts (desktop and phone) playing one run together and
chatting". `e2e-mp/mp-exit.spec.ts` (one test, about 2.5 minutes), run with
`xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts mp-exit --reporter=line` against
`server/dev.ts` with test timing (deadline 600 ms, travel 30 ms, countdown turn 150 ms) and a fixed seed:

| Part | What it shows |
|---|---|
| lobby | A (desktop 1280×800) creates a room on fixture-western from the start page; code, link and QR code in the lobby; B (desktop) opens the link, gets the name sheet and picks a name and a colour; C (phone 390×844, touch) types the code on the start page and joins with its stored profile; the roster has the three names and colours; all ready ("3 of 3 ready"), A starts, the three hashes agree |
| moving | C moves with a tap on the map, B clicks a tile and walks there (a travel step per turn), A moves with the arrow keys while B and C send nothing: A's turns resolve at the deadline without them, B's own player stays put, B's page shows the turn pill meanwhile |
| chat | A presses Enter and types "wasd hello": A does not move and nothing is queued; B sees A typing ("…"), then the line as a bubble over A (or in the column when A is off screen); no bubble overlaps a HUD panel |
| phone chat | C opens the chat sheet from the tools row, sends 👍 and a "Follow me" ping; A and B get both (the ping line in A's column) |
| the run | the in-page autoplay plays all three to the end of the run (a sim bot per page, explorer / cautious / explorer, every action through `controller.actNow` → `RoomSession.act` → input), a chat line about every 40 entries; the run took 90–125 s, 4 areas, won |
| agreement | every area change and the end: the same entry number and `hashState` on all three pages; the final n and hash equal; no autoplay faults; A got B's and C's chat lines |
| exit countdown | the "… the party moves on in {n}" banner was seen on all three screens (a 40 ms sampler in each page records it) |
| end and play again | the end screen on all three, "Play again" for the host and the room block (Ready, Leave room) for the others; A plays again: all three are in the new run's first area, on one hash; no page errors |

Screenshots: `test-results/shots/MP3/exit-*.png` (lobby, pill, chat, sheet, the autoplay on phone and
desktop, end screens, play again on the phone).

## Fixes from the exit check (D5)

- **Bubbles under a HUD panel.** A teammate whose head was just below a top panel got the speech
  bubble above the head, under the panel (only the bubble's bottom showed). The overlay now checks the
  bubble's own top corners and puts the bubble under the feet when they are covered.
- **"Not allowed" after the run ended.** An input or ping that crossed the end of the run on the wire
  came back `bad_phase` and showed the "not allowed" toast. `RoomLink` now logs `bad_phase` quietly
  when the client is no longer in the playing phase (a host action refused while playing still toasts).
- `controller.actNow` returns its Outcome (the autoplay reads whether the session sent the action).

## Gate

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean |
| Unit tests | `npx vitest run` | 190 files, 2264 tests: 2261 passed, 3 failed under the full run's load: the two mapgen timing asserts (`organic / large`, `geometric / large`) and `rooms-exit` "reconnect" (a hostile swung at the dropped player before its `away` entry); alone `generators` + `rooms-exit` 74/74, and `rooms-exit` twice more 7/7 |
| Golden replay | `tests/engine/golden-replay.test.ts` | 6/6, file unchanged since MP1 B0 (02f718c) |
| New-player gate | `npx tsx tools/sim.ts --gate --seeds 40 --jobs 6` | **21/21 worlds pass**, 1680 runs in 97 s |
| Single-player browser smoke | `xvfb-run -a npx playwright test e2e/play.spec.ts e2e/modes.spec.ts` | 19/19 passed (2.2 min) |
| Room specs | `xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts` | 9/9 passed in 5.1 min (`mp-lobby` 3, `mp-chat` 3, `mp-party` 2, `mp-exit` 1) |

## Gate verification (MP3 gate, 2026-10-29, at 22becb4)

Verified, not built: the gate changed no product code. It added only `tests/review/mp3/` (a config and
a spec for the static-build start page) and copied the review screenshots to `test-results/mp3-gate/`.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean |
| Unit tests | `npx vitest run` | 190 files, **2268/2268 passed** (253 s); this time the mapgen timing asserts and `rooms-exit` passed in the full run too |
| Golden replay | `tests/engine/golden-replay.test.ts` | passed in the full run; file unchanged since MP1 B0 (02f718c) |
| New-player gate | not run | nothing under `src/engine` changed since 552639d (`git diff --stat 552639d HEAD -- src/engine` is empty); the D5 run above (21/21) stands |
| Exit check ×3 | `xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts mp-exit` | **3/3 passed**, no retries, no flakes (table below) |
| Single-player e2e | `xvfb-run -a npx playwright test e2e/play.spec.ts e2e/mobile.spec.ts e2e/modes.spec.ts` | **27/27 passed** (14.5 min) |
| Room specs | `xvfb-run -a npx playwright test -c e2e-mp/playwright.mp.config.ts` | **11/11 passed** (6.5 min): `mp-chat` 3, `mp-exit` 1, `mp-lobby` 3, `mp-party` 2, `mp-review-fixes` 2 |
| Static build | `npm run build:static` with and without `ANYWORLD_SERVER_URL` | both build; the Pages build has no rooms card and plays the demo; the autoplay is a stub in both (no sim bots in the bundle) |
| Start page, server stopped | `tests/review/mp3/static.spec.ts` (`STATIC_CASE=none / up / down`) | 3/3 passed: none: no rooms card, demo world plays; up (built with `ANYWORLD_SERVER_URL=http://127.0.0.1:8798`, `server/index.ts` with `ALLOWED_ORIGINS`): rooms "ok" and a room is created from the Pages origin; down (the same build, server killed): "Rooms are unavailable right now", Create disabled, the demo world plays, no page errors |

Exit check runs (A, B desktop 1280×800; C phone 390×844 with touch; one room, the whole run to the
win through every area change, chat, emote and ping, play again):

| Run | Wall time | Autoplay run | Actions sent A / B / C | Server refusals A / B / C | Chat lines per page |
|---|---|---|---|---|---|
| 1 | 2.2 min | 95 s | 827 / 743 / 782 | 47 / 47 / 47 | 39 |
| 2 | 3.0 min | 146 s | 909 / 780 / 768 | 55 / 29 / 29 | 41 |
| 3 | 3.1 min | 143 s | 911 / 849 / 821 | 63 / 54 / 37 | 42 |
| 4 (in the room-spec run) | — | 87 s | 872 / 773 / 770 | 40 / 32 / 33 | 35 |

"Refused here" (by the dry run on the replica) was 0 in every run; the server refusals are the
teammate races listed under the known gaps. The hashes agreed at every area change and at the end in
every run (the spec asserts it).

Screenshots, `test-results/mp3-gate/` (copied from `test-results/shots/MP3/`, which the specs write):
the lobby (`lobby-host-desktop`, `lobby-guest-desktop`, `lobby-phone`, `exit-lobby-phone`,
`chat-lobby-desktop`), the room list on the start page (`start-rooms-desktop`, `start-phone`),
in game with all three players, name tags, rings and a chat bubble plus the side column
(`exit-chat-desktop`, `chat-bubble-desktop`, `chat-offscreen-desktop`, `chat-emotes-desktop`), the
turn pill, spectator and exit countdown (`exit-pill-desktop`, `party-*`), the phone layout (the chat
sheet with emotes and pings `exit-sheet-phone`, `chat-*-phone`, `exit-autoplay-phone-area*`,
`exit-end-phone`, `exit-again-phone`), and the static build (`static-start-none / up / down`,
`static-lobby-up`, `static-game-none / down`).

Observed while reviewing the screenshots (not a failure): during the scripted moving part, teammates
who send nothing show the dimmed "away" name tag on the other screens (`exit-sheet-phone`: "Ola away"),
as designed for idle seats (MP3 design §4); with the 600 ms test deadline a seat turns idle quickly.

## Deferred

- **NPC lines as bubbles for nearby players** (MP4): today an NPC's line shows in the speaking player's
  dialogue panel and in the shared log; teammates nearby do not see it over the NPC's head.
- **The GM line in the lobby is worded for MP4** ("The game master reads the chat; chat lines are sent
  to the AI provider."): in MP3 the room's game master is still the offline canned director, which reads
  no chat and sends nothing anywhere; the line is accurate from MP4, when the AI game master runs next
  to the room.

## Known gaps for MP4 and later

- **The AI game master in rooms** (the plan's MP4): rooms run the offline canned director; the lobby's
  "the game master reads the chat" line is worded for MP4 (see Deferred).
- **NPC lines as bubbles for nearby teammates** (see Deferred).

- **Refusal toasts from races.** A turn action that passed the dry run on the replica can still be
  refused when the turn resolves: a teammate stepped onto the tile first ("Blocked"), took the item
  ("Nothing here to pick up") or killed the target ("No target"). The toast is accurate but can surprise;
  in the exit check the bots, acting within milliseconds of every entry, got about 20–50 each per run.
  A quieter wording for refusals caused by a teammate in the same turn is a possible MP5 polish.
- **Autoplay is a test tool**: `__anyworld.room.autoplay(on, { bot, seed, chatEvery })` exists only in the
  dev server and builds with `ANYWORLD_AUTOPLAY=1` (`__ANYWORLD_AUTOPLAY__`); the Pages and production
  builds do not contain the module or the sim bots.
- **The room specs run at test timing** (600 ms deadline) and on one machine; latency through the real
  exposure path is MP5's playtest.
- **Not deployed**: MP0's exit check (the Dell and the VPS) is still open.
