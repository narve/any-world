# MP2 — Room server: progress note

Date: 2026-10-28. Status: **MP2 exit checks met** (server, protocol and engine bits; no lobby, chat or
multiplayer view in the client: MP3; no AI game master in rooms: MP4). Design and the per-step "as
built" notes: [MP2-DESIGN.md](MP2-DESIGN.md). Plan: [MULTIPLAYER-PLAN.md](../MULTIPLAYER-PLAN.md) §3.
The single-player client does not use rooms and plays as before (golden replay and new-player gate
unchanged, below).

## What MP2 built

| Step | Commit subject | Content |
|---|---|---|
| C1 | engine away/leave/return, boss scaling, offline GM moved to src/gm | `setAway` (away = busy with no turn cap), `leaveMap` (items drop where it stood) / `returnToMap` (empty pack, the hp it left with, next to `near`), `addPlayer` `near`, `unregisterWorld`; bosses tougher with party size (`uniqueHp` 0.8, `uniqueDamage` 0.1, parties of 2+ only); `OfflineGmDirector` and the hooks in `src/gm/offline.ts` |
| C2 | shared net (protocol, log, engine version) | `ws` dependency; `computeEngineVersion` (hash of the tracked engine, schema and lockstep net files) for Vite, vitest, the server and tools, `/api/health.engine`; `src/net/protocol.ts` (zod messages both ways, limits, `peekHello`), `src/net/log.ts` (`applyEntry`: the one function that moves a room), `src/net/messages.ts` (`noticeFor` → i18n keys for the toasts, en/nb) |
| C3 | room core (timing, clock, room, store, demo worlds, manager) | seats, roster, unique names and colours, phases and play again; the turn clock (all acted, deadline, travel cadence, ~1 s countdown turns, area hold, idle/busy/menu/off players inactive); away entries and the 2-minute rule; host hand-over; chat (100 lines, 200 characters, 1/s, typing = busy); canned GM entries; hashes and desync snapshots; world file + snapshot + append log with atomic writes and tombstones; restart replay; limits, idle close, version closing |
| C4 | network (ws upgrade, room routes, data dir, RoomClient) | `/api/ws` on the existing server (Origin, per-IP and per-connection limits, 16 KB frames, backpressure, pings, hello order and timeout); `GET/POST /api/rooms`, `GET /api/rooms/:code`, `POST /api/rooms/:code/world` (409 for an outdated page, uploads through `parseWorld` and a timed trial `createGame`); data dir (`ANYWORLD_DATA_DIR`, systemd `STATE_DIRECTORY`, `.data/`; no start without it); graceful shutdown; `src/net/client.ts` `RoomClient` (lockstep replica, hash reports, reconnect with token and `lastN`) |
| C5 | scripted clients, room bots, exit checks | `tools/rooms/scripted-client.ts` (`ScriptedClient`: RoomClient + sim bot + chat script; `FaultyChannel`), `tools/room-bots.ts`, `tests/server/rooms-exit.test.ts`; turn outcomes on RoomClient's `entries` event; a test-only deadline override; the "illegal actions" log line |

## Exit checks

Plan §3, MP2: "server tests with 4 scripted clients chatting and playing, kill and restart mid-run, a
deploy with a new engine version closes rooms with a toast, an outdated client is refused with a reload
toast, a disconnect and reconnect, packet delay and loss". All in `tests/server/rooms-exit.test.ts`
(7 tests, about 40 s), over real sockets, with room timing for tests (deadline 300 ms, travel 20 ms,
countdown turn 50 ms):

| Check | Test | What it shows |
|---|---|---|
| 4 scripted clients chatting and playing | play | 4 bots (explorer, cautious, talker, newbie) play ≥ 150 entries and on into the second area, a chat line about every 25 entries: every replica ends on the server's `hashState`, no desync snapshot, every client's chat history equals the server's, typing made busy entries, the canned GM spoke (`intro`, `area_enter`) |
| kill and restart mid-run | restart | a child server is killed with SIGKILL while the bots play; its files replay to exactly the entries the clients applied (and match an uninterrupted replay from the run start); restarted on the same port and data dir, the clients reconnect with their tokens as the same players, catch up by entries, play 50 more, agree; a SIGTERM snapshot equals their state |
| a deploy with a new engine version closes rooms with a toast | version | restart with another `ANYWORLD_ENGINE_VERSION`: the room files are gone and `/api/rooms` is empty; the open pages reconnect and get `net.outdated` with a reload button; a reloaded page with the old token gets `room_closed / server_updated` → `net.serverUpdated` |
| an outdated client is refused with a reload toast | outdated | `hello` with an old engine (also with an otherwise invalid hello) → `refused outdated, reload: true`, close 4001, `noticeFor` → `net.outdated` with reload; `POST /api/rooms` from a listed origin → 409 `{ kind: 'outdated', reload: true }` |
| a disconnect and reconnect | reconnect | a dropped client shows `off`, its character gets an `away` entry, the others play 30+ entries without waiting, no hostile targets or attacks it; on return the same pid, a `back` entry, no snapshot needed |
| packet delay and loss | faults | 4 bots with 20–250 ms jitter on every frame, stalls of 600 ms, random socket closes with reconnects and 5 % lost inputs, ≥ 100 entries: every client ends on the server's hash (snapshots allowed and counted; a typical run needed none), turns went on without the lost inputs |
| (design §11) bots against a real server | bots | `tools/room-bots.ts` as a child process against a child server with the computed engine version (not `'dev'`): joins, plays, the bots agree |

The toast itself (and its reload button) is MP3's UI; MP2 delivers the i18n keys through `noticeFor`.

## Gate

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | clean |
| Unit tests | `npx vitest run` | 178 files, **2165 tests, all passed** (232 s), golden replay included and unchanged |
| New-player gate | `npx tsx tools/sim.ts --gate --seeds 40 --jobs 6` | **21/21 worlds pass** (1680 runs, 90 s), the same rates as MP1 (single player is unchanged) |
| Parties with boss scaling | `npx tsx tools/sim.ts --party-sizes 1,2,3,4 --seeds 10 …` (C1) | 0 crashes, fell within a point of MP1; numbers in MP2-DESIGN "C1 as built" |

By hand: `npx tsx tools/room-bots.ts --url http://127.0.0.1:<port> --bots 4 --entries 200` against a
dev server played 207 entries in about 4 s, 4 clients on one hash, no desyncs.

## Known gaps for MP3 and later

- **No client UI for rooms yet** (MP3): lobby (create, room list, join by link or code), roster with
  names and colours, the multiplayer view with the joined player's id instead of the lead, chat with
  typing, and the toasts for `noticeFor` keys (reload button for `net.outdated`). `RoomClient` is ready
  for the browser (`WebSocket` as the socket factory) and now reports turn outcomes with the entries.
- **Connect the creator first**: a guest whose `hello` arrives before the creator's first `hello`
  becomes host (C3 rule). The lobby should connect right after `POST /api/rooms`.
- **Presence**: the client must send `presence` (`menu` for a hidden tab or a menu) and `typing`; an
  idle player stops holding up turns after 10 s.
- **No AI game master in rooms** (MP4): the canned director answers; it reads the lead's fog only.
- **Map generation on the main thread**: an area change at 12 players stalls every room for up to
  ~0.6 s (a possible improvement in the plan, not planned).
- **Not deployed**: MP0's exit check (the Dell and the VPS) is still open; deploy the Pages build and
  the server together (HOSTING.md §6), with `TRUST_PROXY=1` behind Caddy.
