# Multiplayer edition — plan

Status (2026-10-31): MP0 (hosting groundwork) is in the code and deployed: the server has been live at
`https://any-game.dv8.no` since 2026-10-28 (the Dell behind the VPS, see [HOSTING.md](HOSTING.md)). Its
exit check (HTTPS from a phone on 4G) is not yet confirmed. MP1 (engine: parties) is done
(2026-10-27): its exit checks are met, see [MP1.md](progress/MP1.md). MP2 (room server) is done
(2026-10-28): its exit checks are met and verified by the MP2 gate, see [MP2.md](progress/MP2.md). MP3
(multiplayer client) is done (2026-10-29): its exit check is met and verified by the MP3 gate, see
[MP3.md](progress/MP3.md). MP4 (the game master for parties) is done (2026-10-29): its exit check is met and verified by the MP4
gate, see [MP4.md](progress/MP4.md). MP5 (verify) was verified as far as possible before deployment
(2026-10-30): playtests, audits and two fix rounds done, and the gate passed. The DoD table is in
[MP.md](progress/MP.md). What remains: MP0's phone-on-4G check, the latency playtest through the
deployed path, and a short session with real people. The four owner decisions from MP5 are made (§6).
The multiplayer edition is merged into `main` (PR #2); the pages at `any.dv8.no` are HOSTING.md §8, step 6.
Requirements: DESIGN §2.5 (fun and fluent beats exact) and §12 (sharing, multiplayer without waiting,
chat). Hosts: the owner's Dell laptop runs the server, reached over WireGuard; for development and
testing the server also runs on the owner's development laptop.

**Guiding priority: fast and fun.** Nobody waits, and talking to each other is a big part of the game.
When a rule has to choose between exact turn fairness and keeping the party moving and chatting, it
keeps them moving and chatting. Breaking old saves, rooms or worlds is acceptable in this phase as long
as it fails gracefully (a new game or a closed room, with a short toast); no migration code.

## 1. What we build

- **Co-op, 2–8 players (up to 12 as a room option), one shared run** in one world (recorded, imported or
  AI-made). No PvP in the first version.
- **No waiting.** Turns are simultaneous with a short deadline: the server advances the world when every
  active player has acted, or a deadline after the first action, whichever comes first. The host picks
  the deadline per room, 1–5 s (default 2 s). A player who has not acted simply waits that turn. While
  nobody acts, the world does not move, so a party that stops to chat loses nothing.
- **Pace (§2.1):** walking must not be slowed by the turn clock. Click/tap travel keeps its quick
  cadence when nothing hostile is in view, and a player who is only reading, chatting or in a menu
  never holds up the others.
- **Chat is a main feature, not an add-on** (DESIGN §12): speech bubbles over the speaker when they are on
  screen, otherwise a line in the side column with name and colour; Enter on desktop and an always-visible
  chat button on phones. Typing never triggers game keys and never costs a turn. Quick reactions (a few
  one-tap emotes and "follow me" / "wait" / "help" pings on the map) for phones. History of the last 100
  lines per room, 200 characters per message, 1 message/s. A player who is typing shows a "…" bubble.
- **Joining:** the host creates a room and shares a link (`…/?room=K7QX`) and a QR code; open rooms are
  also listed on the start page. Players pick a name and a colour; no accounts. Late joiners appear
  next to the host at the next turn (engine `addPlayer`).
- **Falling in a fight:** every player has their own second chance. The first time a player would be
  defeated they get straight back up at half health (as Gentle's second chance does in single player,
  per player instead of per run; on Gentle and Normal). A second fall leaves them down, watching
  through a teammate's camera, until a teammate stands next to them for one turn or 20 turns pass;
  then they are back at half health. The run is lost only when everyone is down at once.
- **Area exits:** the first player to take an exit starts a countdown of about 10 seconds ("The party
  moves on"); everyone is pulled along when it ends, and players who are down arrive standing at half
  health. No one waits at the door. The engine counts the countdown in turns (`partyRules.exitCountdownTurns`,
  5 by default); the room server sets the number and the turn pace so it lasts about 10 s (§2.1).
- **The AI game master** runs only on the server (keys stay there). It sees the whole party and reads
  the chat (it may answer a joke or weave a plan into the story), and its actions go into the shared
  turn stream like any other input.

## 2. Architecture

```
browser (each player)                         home laptop (Node 22, systemd)
  client: renderer + UI + engine copy  ⇄ wss ⇄  room server: authoritative engine, GM, persistence
  sends:   action, chat, ready                    sends: turn {n, actions[], gm[]}, chat, roster, snapshot
```

- **Lockstep on a deterministic engine.** The engine already gives the same result for the same seed and
  inputs (no Date or Math.random in `src/engine`). The server collects the inputs for turn *n* and
  broadcasts them. Every client runs the same `step` locally, so the traffic is a few hundred bytes per
  turn. The server runs it too and is the authority.
- **Desync guard:** clients send a state hash every 10 turns. On a mismatch the server sends a full
  snapshot. Fog of war is a client view (cheating is possible but harmless in co-op).
- **Engine version:** a hash of the engine source (`src/engine`, `src/schema`) baked in at build time, so
  any engine change counts as a new version; no hand-kept number to forget. Both sides carry it: the
  pages (GitHub Pages) and the server (the Dell) are deployed separately, and every browser runs its own
  copy of the engine, so a client sends its version when it joins and the server refuses a mismatch with
  a short "a new version is out, reload the page" toast.
- **Protocol:** one message schema shared by client and server (zod, like the rest of the code), validated
  on both sides; invalid or unknown messages are dropped and counted.
- **Persistence:** each room's world, seed, engine version, a snapshot and the input log since it, in
  `<ANYWORLD_DATA_DIR>/rooms/<id>.json`. `ANYWORLD_DATA_DIR` defaults to `/var/lib/anyworld` (the systemd
  unit's `StateDirectory`); on the development laptop it points at a gitignored folder in the repo. The
  server creates the directory at start-up and refuses to start if it cannot. A restart replays the log;
  players reconnect with a token kept in their browser. **After a deploy that changes the engine
  version**, old rooms are closed with a short toast ("the server was updated; start a new room"); no
  replay across versions.
- **World for a room:** worlds are made and play-tested in the host's browser today. The host uploads
  the chosen world; the server validates it (`parseWorld`, untrusted input) before opening the room.
  Recorded demo worlds need no upload: the server loads them from `content/worlds` (it does not today).
- **Limits:** 10 rooms, 8 players per room by default (`MAX_PLAYERS`, up to 12), idle rooms closed after
  2 hours.

### 2.1 Turns, pace and talking

- **Active players:** a player counts towards "everyone has acted" only while they are playing the map.
  Reading a dialogue, trading, typing in chat, in a menu or idle for 10 s makes them inactive: the
  others' turns resolve as soon as the active players have acted, without the deadline.
- **Travel:** a player on click/tap travel sends their next step automatically every turn. Turns where
  all active players are travelling (or waiting) resolve at the travel cadence (~100 ms), not the
  deadline. The deadline only applies while someone is deciding.
- **Safe while talking:** a player in a dialogue, a trade or typing is "busy" and hostiles do not start
  new attacks on them (they may still close in), for at most 10 turns (engine `BUSY_MAX_TURNS`), so a
  stuck or idle client cannot stay immune. The playtest already flagged enemies gathering during a
  conversation; with more NPCs and chat this matters more.
- **The server must know who is travelling:** the turn input carries the player's intent (deciding,
  travelling, busy/typing), so the server can pick the travel cadence or the deadline. During an exit
  countdown the server paces turns at about 1 s each, so the countdown neither races past at the travel
  cadence nor drags at the deadline.
- **Area entry:** generating the next area takes up to ~0.6 s with 12 players (MP1 measurement); that
  time never counts against anyone's deadline.
- **NPC conversations:** worlds now place 2–4 NPCs per area (world prompt, 2026-10-26). A dialogue is
  per player and does not pause anyone. Other players near the speaker see the NPC's lines as bubbles.

### How many players?

The server and network are not the limit: lockstep sends a few hundred bytes per turn, and the engine
steps a turn in well under a millisecond, so a laptop could run dozens. The limits are in the game:

- **Map space:** areas are sized for one player and the owner does not want them smaller. With 8 or
  more, rooms and corridors jam. The map generators get a party size, and areas grow by about 15% per
  extra player (map sizes are fixed per small/medium/large today: 32×24, 44×32, 56×40).
- **Turns:** the more players, the more turns end on the deadline rather than when everyone has acted.
  §2.1 keeps this from slowing walking and talking.
- **Screen:** the camera frames the local player. Name tags, chat bubbles and the turn indicator become
  crowded with many players on one screen, and phones show fewer of them.
- **Balance:** hostile numbers and health scale with party size. This is tested by bots up to 12.
- **GM:** the game master's context grows per player, which makes it slower and costlier.

Plan: design and test for 8; allow up to 12 as an option, tested with bots and a smoke test in the browser.

## 3. Work, in milestones

| # | Milestone | Content | Exit check |
|---|---|---|---|
| MP0 | Hosting groundwork (useful for single player too) | done in code: `systemd` unit and env file, `scripts/deploy.sh`, `/api/health`, **host access code** (`ANYWORLD_HOST_CODE`), split hosting (`ALLOWED_ORIGINS` on the server, `ANYWORLD_SERVER_URL` at build time), Node.js version guard | the single-player game runs on the laptop, reachable over HTTPS from a phone on 4G. **Deployed** 2026-10-28 at `https://any-game.dv8.no`; the phone-on-4G check is not yet confirmed |
| MP1 | Engine: parties | `GameState.players` (map) instead of `player`, per-player inventory, knowledge, levelling, statuses, FOV and remembered rooms, second chance (`mercyUsed`) and `pendingChoice` (dialogue, trade, offers; today one shared field used in ~65 places); `stepTurn(state, inputs[])` with a fixed resolution order; enemy AI picks among players and skips busy ones (§2.1); party-loss rule; exit countdown; hostile strength and map size scaled by party size; single player = a party of one, and all current tests still pass. Size: about 120 `state.player` uses in 24 engine files plus 53 `playerActor(ctx)` calls | engine tests; **multi-player bots** (the sim bots drive one player today) playing 2–4 player runs over all 21 worlds with 0 crashes and no soft-locks, plus at least one full run with the maximum party (12 bots) on one world, with 0 crashes, no soft-locks and turn times reported |
| MP2 | Room server | WebSocket on the existing `node:http` server (`ws` package, not yet a dependency; `Origin` checked against `ALLOWED_ORIGINS`); rooms and the public room list (`GET /api/rooms`); roster (names, colours, the player id each connection plays) and reconnect tokens; leaving and disconnects (§6); turn pacing: deadline, active/busy players, travel cadence, ~1 s turns during an exit countdown, area entry not counted (§2.1); input validation and message size limits; input log, snapshots and replay; engine-version check; desync hashes (`hashState`); world upload and validation, demo worlds from `content/worlds`; **chat relay** (history of 100 lines, 200 characters, 1 message/s, typing state) so MP3 only adds the UI; rate limits; persistence under `ANYWORLD_DATA_DIR`; shared message protocol; client engine-version check (outdated pages get a reload toast). Rooms run without the AI game master until MP4: the server answers GM moments with the world's canned lines, as the offline demo does. Engine: bosses (unique hostiles) tougher with party size, on top of MP1's party scaling (§6) | server tests with 4 scripted clients chatting and playing, kill and restart mid-run, a deploy with a new engine version closes rooms with a toast, an outdated client is refused with a reload toast, a disconnect and reconnect, packet delay and loss |
| MP3 | Client | lobby (create, share link and QR code, public list of open rooms on the start page, roster, ready, world picker); the client plays its own player id (today it plays the lead, `leadPlayer`); other players with name tags and colours; per-player view (fog, compass, hints, persuade odds are already computed per state and become per player); turn indicator ("2 of 3 acted"), never blocking; chat as in §1 (bubbles, side column, typing indicator, emotes and map pings, phone chat button); en and nb strings | Playwright with 3 browser contexts (desktop and phone) playing one run together and chatting |
| MP4 | GM and dialogue for parties | **move the GM from the browser to the server**: today the request queue (`src/client/gm-director.ts`) runs in the client and may use the player's own key; in rooms it runs next to the room. GM context with all players and per-player hooks (low health); dialogue and trade per player without pausing others; party-aware world-generation prompt; recordings for demo rooms | GM checks still refuse fiat; demo rooms play without AI |
| MP5 | Verify | review, playtest and fix rounds as in M5; latency playtest through the real exposure path; a short session with real people, judged on "was it fast, did we talk" | DoD table in `docs/progress/MP.md` |

Order: MP0–MP4 are built and verified; MP5 was verified as far as possible on the development laptop
(see [MP.md](progress/MP.md)). The real server went live on 2026-10-28 (the Dell and the VPS,
`https://any-game.dv8.no`); work and tests still run on the development laptop. MP0's exit check is done
once a phone on 4G is confirmed, and MP5's latency playtest and real-people session run against the
deployed server. MP1 ran as one workflow (design with critiques, sequential builders, review, fix, gate); MP2 and MP3
had the same shape. Branch: `multi`.

Possible improvements, not planned yet:
- **Map generation off the main thread.** Entering an area at 12 players takes up to ~0.6 s of map
  generation, and Node runs every room on one thread, so other rooms stall for that moment. A worker
  thread, or generating the next area ahead of time, would remove the stall. Not worth the complexity
  until rooms are busy (owner, 2026-10-28).

## 4. Hosting

**Decided (2026-10-26):** production runs on the **Dell laptop**, reached over **WireGuard** through the
owner's **VPS** (Caddy, HTTPS, public links): `any-game.dv8.no` for the server, `any.dv8.no` for the
pages (§5).
Development and testing run on the development laptop (same setup, or just `npm run dev`; multi-player
tests use several browser contexts against it).

Step by step in [HOSTING.md](HOSTING.md) (Ubuntu and Arch/CachyOS; the Dell runs Ubuntu Server 26.04
with Node.js from nodejs.org). In short:

1. **Packages:** a patched Node.js (22.23.4+, 24.22.1+ or 26.12.1+; HOSTING.md §1), npm and git. Clone
   the repo to `/opt/anyworld` and run `npm ci && npm run build`.
2. **Service:** a dedicated user `anyworld`. Keys go in `/etc/anyworld.env` (mode 600), for example
   `ANTHROPIC_API_KEY=…`, `ANYWORLD_HOST_CODE=…` and `PORT=8787`. `deploy/anyworld.service` runs
   `npm start` with `Restart=always`, `ProtectSystem=strict` and `StateDirectory=anyworld`.
3. **Keep it awake:** in `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and
   `HandleLidSwitchExternalPower=ignore`, and turn off automatic suspend in the desktop power settings.
4. **Expose it**, with no ports opened on the home router either way:
   - **Tailscale Funnel (fastest):** `sudo systemctl enable --now tailscaled`, `sudo tailscale up`, allow
     Funnel for the machine in the Tailscale admin console, then `sudo tailscale funnel --bg 8787`. The
     game is then at `https://<laptop>.<tailnet>.ts.net`, with TLS and WebSockets handled. It cannot use
     a custom domain.
   - **Cloudflare Tunnel (to use dv8.no):** move the DNS for `dv8.no` to Cloudflare (free plan; the
     whole domain), install `cloudflared`, and route a name such as `any-game.dv8.no` to `http://localhost:8787`. It
     supports WebSockets, and Cloudflare Access can put a login in front if wanted.
   - **WireGuard with a VPS relay (chosen):** WireGuard connects devices that hold a config. On its
     own it is a private network: each player needs the WireGuard app and a config from the owner (fine
     for a few friends, not for open links). For public links, run a small VPS with a public IP as a
     relay. The laptop keeps a WireGuard tunnel to the VPS (`PersistentKeepalive`, so no router setup at
     home). On the VPS, Caddy serves `any-game.dv8.no` with automatic HTTPS and proxies (WebSockets
     included) through the tunnel to `10.x.x.2:8787`. DNS: an A record for `any-game.dv8.no` pointing to
     the VPS. This is the do-it-yourself version of what Tailscale Funnel and Cloudflare Tunnel provide.
   - Router port-forward with Caddy and dynamic DNS also works, but it exposes the home IP and fails
     behind CGNAT. Not recommended.
5. **Updates:** `scripts/deploy.sh` runs git pull, `npm ci`, the build and a service restart. Rooms
   survive a restart; a deploy that changes the engine closes them gracefully (§2).
6. **Safety:** set a spending limit on the API key; the host code and rate limits stop casual abuse.
   Nothing else on the laptop is exposed.

## 5. Web pages elsewhere, server at home

**Decided (2026-10-26): pages and server apart, both under `dv8.no`.**

- **`any.dv8.no`: the web pages.** The static build on GitHub Pages (already built and deployed by
  `.github/workflows/pages.yml`), with `any.dv8.no` as its custom domain: a CNAME record to
  `narve.github.io` and the domain set in the repo's Pages settings. Always on: when the Dell is off,
  the page still loads and plays the demo worlds, and online features say "server offline".
- **`any-game.dv8.no`: the game server** (API now, WebSocket rooms later). An A record to the VPS;
  Caddy there proxies through WireGuard to the Dell.
- **Wiring** (already supported since MP0): the Pages build gets `ANYWORLD_SERVER_URL=https://any-game.dv8.no`
  (a repository variable for the workflow), the server `ALLOWED_ORIGINS=https://any.dv8.no`. Both names
  are under `dv8.no`, so they count as the same site: cookies and tokens are not third-party.
- **For MP2:** CORS does not cover WebSockets, so the room server must check the `Origin` header of each
  WebSocket upgrade against `ALLOWED_ORIGINS` itself.

The two layouts compared:

| | One origin (recommended) | Pages front + home server |
|---|---|---|
| Page | served by the server (e.g. `any-game.dv8.no`) | GitHub Pages at `any.dv8.no` (chosen) |
| API and WebSocket | same origin, no CORS | `https://any-game.dv8.no` / `wss://…`; the server needs CORS for the Pages origin (`ALLOWED_ORIGINS`), and the client a build-time server URL (`ANYWORLD_SERVER_URL`) |
| Auth | a cookie works | a token in headers (third-party cookies are blocked) — or keep both under `dv8.no` so they count as the same site |
| When the laptop is off | nothing loads | the page still loads and plays demo worlds; online features say "server offline" |

Both sides must be HTTPS, because an HTTPS page cannot call an `http://` server. Funnel and Cloudflare
Tunnel both provide that.

An alternative that keeps one origin and stays always on: Caddy on the VPS serves the static files for
`any.dv8.no` itself and proxies only `/api` (and later the WebSocket path) to the Dell. It needs a step
that copies each build to the VPS, so it is not the first choice.

## 6. Decisions for the owner

Decided:
- 2026-10-25: co-op only; party of 8 by default (12 as an option); turn deadline 1–5 s chosen per room
  (default 2 s).
- 2026-10-26: fast and fun first, chat is a big part of the game; every player has their own second
  chance (straight back up at half health), instead of waiting out the area as a downed spectator;
  backward compatibility is not a priority (fail gracefully, no migrations).
- 2026-10-26: the server runs on the Dell laptop, exposed over WireGuard through the owner's VPS
  (public links, Caddy with HTTPS); pages at `any.dv8.no` (GitHub Pages), server at
  `any-game.dv8.no`; development and testing on the development laptop.
- 2026-10-26: a second fall: the player is down and watches through a teammate's camera; they get up
  at half health when a teammate stands next to them for one turn, or by themselves after 20 turns.
- 2026-10-26: the second chance applies on Gentle and Normal (one per player), not on Hard and Brutal.
- 2026-10-26: the game master reads the player chat and may react to it. The lobby says so in one line,
  since chat then goes to the AI provider.
- 2026-10-26: anyone may create a room (no access code); the room limits (§2) apply.
- 2026-10-26: deployment to the real server waits; development and testing run on the development
  laptop until then (MP0's exit check stays open). Deployed on 2026-10-28 (`any-game.dv8.no`).
- 2026-10-26 (single player): bosses get generally a bit more health. Done in MP1 prep (`1f9378f`):
  unique hostiles get 25 % more hp on every difficulty.
- 2026-10-26: the AI game master runs in every room, also rooms created without the host access code;
  its cost is not a concern (the spending limit on the API key is the safeguard). Making a new AI world
  still needs the code, as today.
- 2026-10-26: rooms are listed publicly: the start page shows open rooms (world, players, joinable),
  besides joining by link.

- 2026-10-28 (for MP2): clients and the server compare the engine version, and an outdated page is
  refused with a reload toast; chat's server side is part of MP2; the exit countdown lasts about 10 s
  of clock time, the server pacing its turns; no AI game master in rooms until MP4; one shared message
  protocol; room files under a configurable `ANYWORLD_DATA_DIR`, created at start-up (the server refuses
  to start if it cannot); map generation in a worker thread is a possible improvement, not planned.

- 2026-10-28: a player who disconnects or leaves: their character stays where it is for 2 minutes,
  counts as inactive (never holds up a turn) and as busy for hostiles (the 10-turn cap applies), and
  comes back under their control when they reconnect with their token. After 2 minutes away it leaves
  the map; its items drop where it stood and its place in the room is kept until the run ends.
- 2026-10-28: at the end of a run, the end screen offers "play again" in the same room (same players,
  the same or another world, a new run); the room closes when everyone has left.
- 2026-10-28: party difficulty: bosses (unique hostiles) get tougher with the number of players; the
  rest of the party scaling stays as MP1 tuned it (relaxed co-op on Normal). To do in MP2 (engine).
- 2026-10-28: the host leaves: the room goes on; the longest-connected player becomes host.
- 2026-10-28: no kicking yet (possible later moderation).

Built in MP1 as proposed in its design, confirmed by the owner (2026-10-28):
- Second chance for a party of one on Normal: none (today's single-player rule, so single player is
  unchanged); parties of 2+ get one per player on Gentle and Normal.
- On Hard and Brutal (no second chance) a player's first fall makes them down, with the same revive
  rules; the run is lost only when everyone is down.
- Taking an exit pulls down players along and they arrive standing at half health (an exit acts as a
  revive).
- Currency is one shared party purse (items stay personal).
- XP is shared in full: every player gets each kill's XP; levels and perks stay per player.

- 2026-10-30 (MP5 questions): world clocks scale with the party (O1): rule triggers that fire every N
  turns, per-turn resource drains and `turn` conditions run slower by 1 + 0.06·(n − 1) (about 1.66 at 12
  players; `PARTY_SCALING.worldClock`, `worldClockFactor`); a chat line the GM cannot answer stays
  silent (O3); party difficulty at Normal stays as it is for now (O4), but bosses get tougher with the
  number of players: `uniqueHp` 0.8 → 1.0 and `uniqueDamage` 0.1 → 0.2 per extra player.

- 2026-10-30: the GM call budget stays at 400 calls per room per hour for now
  (`ANYWORLD_GM_ROOM_CALLS_PER_HOUR`), with no separate chat reserve; revisit after the session with
  real people (measured so far: about 9 calls a minute for 3 players).

Open: none (2026-10-31). What remains needs a phone on 4G or people (MP.md "Open").
