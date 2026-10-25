# Multiplayer edition — plan

Status: plan, not started (2026-10-25). Requirements: DESIGN §2.5 (fun and fluent beats exact) and §12
(sharing, multiplayer without waiting, chat). Target host: the owner's spare laptop (CachyOS) at home,
reachable from the internet.

## 1. What we build

- **Co-op, 2–4 players, one shared run** in one world (recorded, imported or AI-made). No PvP in the
  first version.
- **No waiting.** Turns are simultaneous with a short deadline: the server advances the world when every
  connected player has acted, or 1.5 s after the first action, whichever comes first. A player who has not
  acted simply waits that turn. A player in a menu, a dialogue or a trade never holds up the others.
- **Joining:** the host creates a room and shares a link (`…/?room=K7QX`). Players pick a name and a
  colour; no accounts. Late joiners appear next to the host at the next turn.
- **Death is not the end of the fun:** a downed player watches (camera follows a teammate) and comes back
  at the next area entrance with half health. The run is lost only when everyone is down at once.
- **Area exits:** the first player to take an exit starts a 10-second countdown ("The party moves on");
  everyone is pulled along when it ends. No one waits at the door.
- **Chat** as specified in DESIGN §12: a speech bubble over the speaker when they are on screen, otherwise
  a line in the side column (name and colour). Enter on desktop, a chat button on phones. Typing never
  triggers game keys. History of the last 100 lines per room, 200 characters per message, 1 message/s.
- **The AI game master** runs only on the server (keys stay there). It sees the whole party, and its
  actions go into the shared turn stream like any other input.

## 2. Architecture

```
browser (each player)                         home laptop (Node 22, systemd)
  client: renderer + UI + engine copy  ⇄ wss ⇄  room server: authoritative engine, GM, persistence
  sends:   action, chat, ready                    sends: turn {n, actions[], gm[]}, chat, roster, snapshot
```

- **Lockstep on a deterministic engine.** The engine already gives the same result for the same seed and
  inputs. The server collects the inputs for turn *n* and broadcasts them. Every client runs the same
  `step` locally, so the traffic is a few hundred bytes per turn. The server runs it too and is the
  authority.
- **Desync guard:** clients send a state hash every 10 turns. On a mismatch the server sends a full
  snapshot. Fog of war is a client view (cheating is possible but harmless in co-op).
- **Persistence:** each room's world, seed and input log in `/var/lib/anyworld/rooms/<id>.json`. A
  restart replays the log; players reconnect with a token kept in their browser.
- **Limits:** 10 rooms, 4 players per room, idle rooms closed after 2 hours.

## 3. Work, in milestones

| # | Milestone | Content | Exit check |
|---|---|---|---|
| MP0 | Hosting groundwork (useful even for single player) | `systemd` unit and env file; deploy script; `/healthz`; **host access code** (`ANYWORLD_HOST_CODE`) required to create AI worlds or rooms, so strangers cannot spend the API key; optional split hosting (§5): `ALLOWED_ORIGINS` (CORS) on the server and `VITE_ANYWORLD_SERVER` in the client build | the game runs on the laptop, reachable over HTTPS from a phone on 4G |
| MP1 | Engine: parties | `GameState.players` (map) instead of `player`; per-player inventory, knowledge, levelling, statuses and FOV; `stepTurn(state, inputs[])` with a fixed resolution order; enemy AI picks among players; downed / rejoin / party-loss rules; exit countdown; hostile strength scaled by party size; single player = a party of one, and all current tests still pass | engine tests, bots playing 2–4 player runs over all 20 worlds with 0 crashes and no soft-locks |
| MP2 | Room server | WebSocket on the existing `node:http` server (`ws` package); rooms, roster, reconnect tokens, the turn deadline, input log and replay, desync hashes, rate limits, persistence | server tests with 4 scripted clients, kill and restart mid-run, packet delay and loss |
| MP3 | Client | lobby (create, share link and QR code, roster, ready, world picker); other players rendered with name tags and colours; turn indicator ("2 of 3 acted"), never blocking; downed or spectator camera; chat (bubbles and side column, mobile chat button); en and nb strings | Playwright with 3 browser contexts (desktop and phone) playing one run together |
| MP4 | GM and dialogue for parties | GM context with all players and hooks per player (low health); dialogue and trade per player without pausing others; party-aware world-generation prompt; recordings for demo rooms | GM checks still refuse fiat; demo rooms play without AI |
| MP5 | Verify | review, playtest and fix rounds as in M5; latency playtest through the real tunnel; a short session with real people | DoD table in `docs/progress/MP.md` |

The orchestration would follow M3–M5: builders own directories (engine, server, client, llm), then
integration, review and fix rounds, and a gate. MP1 is the largest and riskiest part. MP0 can start at
once and does not depend on the rest.

## 4. Hosting on the laptop (CachyOS)

1. **Packages:** `sudo pacman -S --needed nodejs npm git tailscale`. Clone the repo to `/opt/anyworld`
   and run `npm ci && npm run build`.
2. **Service:** a dedicated user `anyworld`. Keys go in `/etc/anyworld.env` (mode 600), for example
   `ANTHROPIC_API_KEY=…`, `ANYWORLD_HOST_CODE=…` and `PORT=8787`. A `systemd` unit runs
   `npm start` with `Restart=always`, `ProtectSystem=strict` and `ReadWritePaths=/var/lib/anyworld`.
   Enable it with `systemctl enable --now anyworld`.
3. **Keep it awake:** in `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and
   `HandleLidSwitchExternalPower=ignore`, and turn off automatic suspend in the desktop power settings.
4. **Expose it**, with no ports opened on the home router either way:
   - **Tailscale Funnel (fastest):** `sudo systemctl enable --now tailscaled`, `sudo tailscale up`, allow
     Funnel for the machine in the Tailscale admin console, then `sudo tailscale funnel --bg 8787`. The
     game is then at `https://<laptop>.<tailnet>.ts.net`, with TLS and WebSockets handled. It cannot use
     a custom domain.
   - **Cloudflare Tunnel (to use dv8.no):** move the DNS for `dv8.no` to Cloudflare (free plan; the
     whole domain), install `cloudflared`, and route `play.dv8.no` to `http://localhost:8787`. It
     supports WebSockets, and Cloudflare Access can put a login in front if wanted.
   - Router port-forward with Caddy and dynamic DNS also works, but it exposes the home IP and fails
     behind CGNAT. Not recommended.
5. **Updates:** `scripts/deploy.sh` (MP0) runs git pull, `npm ci`, the build and a service restart.
   Rooms survive restarts (§2).
6. **Safety:** set a spending limit on the API key; the host code (MP0) and rate limits stop casual
   abuse. Nothing else on the laptop is exposed.

## 5. Web pages elsewhere, server at home

This is possible, but serving everything from the laptop is simpler and is the recommendation for the
multiplayer edition. Both options:

| | One origin (recommended) | Pages front + home server |
|---|---|---|
| Page | served by the laptop (`play.dv8.no` or `…ts.net`) | GitHub Pages, optionally at `anyworld.dv8.no` (a CNAME to `narve.github.io` plus the custom domain set in the repo's Pages settings) |
| API and WebSocket | same origin, no CORS | `https://play.dv8.no` / `wss://…`; the server needs CORS for the Pages origin, and the client a build-time server URL |
| Auth | a cookie works | a token in headers (third-party cookies are blocked) — or keep both under `dv8.no` so they count as the same site |
| When the laptop is off | nothing loads | the page still loads and plays demo worlds; online features say "server offline" |

Both sides must be HTTPS, because an HTTPS page cannot call an `http://` server. Funnel and Cloudflare
Tunnel both provide that.

A good combination: GitHub Pages at `anyworld.dv8.no` stays the always-on offline demo, with a
"Play online" button that goes to `play.dv8.no` on the laptop.

## 6. Decisions for the owner

1. Funnel (`…ts.net`, ready in minutes) or Cloudflare Tunnel with `dv8.no` (needs the DNS moved)?
2. Co-op only, as planned, or also a competitive mode later?
3. Party size limit (4 planned) and turn deadline (1.5 s planned)?
4. Start with MP0 now (hosting, host code, optional split hosting) before the multiplayer work?
