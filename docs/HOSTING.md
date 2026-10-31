# Hosting AnyWorld at home

How to run the AnyWorld server on a spare Linux machine (Arch/CachyOS and Ubuntu Server; other systemd
distributions work the same way) and make it reachable from the internet. This is milestone MP0 of
[the multiplayer plan](MULTIPLAYER-PLAN.md). It is useful for the single-player game already.

**Live since 2026-10-30:** the server runs on a Dell laptop with Ubuntu Server 26.04 at the owner's home,
reached through WireGuard and Caddy on the owner's VPS at `https://any-game.dv8.no`; the pages are on GitHub
Pages at `https://any.dv8.no`. §8 is the checklist it went live with.

## 1. Node.js: patched releases only

The server refuses to start on a Node.js release with the Brotli decoder flaw **CVE-2026-111497**
("HTTP2Shell"; [Node.js security release, 21 Oct 2026](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)).
The server's calls to AI providers decompress Brotli responses, so this matters here. Use
**22.23.4+, 24.22.1+ or 26.12.1+**:

```bash
sudo pacman -Syu --needed nodejs-lts-jod npm git   # Node 22 LTS; or nodejs-lts-krypton (24), or nodejs (current)
node -v                                            # must be one of the versions above
```

Three guards enforce this: `package.json` `engines` with `engine-strict` in `.npmrc` (so `npm ci`
fails on an unpatched runtime), a check when the server starts (`server/node-check.ts`), and the
GitHub Pages build, which uses the version in `.nvmrc`. `ANYWORLD_ALLOW_UNPATCHED_NODE=1` overrides the
startup check, for an isolated development machine only.

Distribution packages that link a shared `libbrotli` (Debian and Ubuntu `nodejs`) get the Brotli fix
from the system library and may keep an old version number. The check goes by the version, so use a
release from nodejs.org or your distribution's patched Node package.

**Ubuntu / Debian:** the distribution's `nodejs` fails the check (Ubuntu 26.04 ships 22.22.1), so install the
official build from nodejs.org. Verify it first: download `SHASUMS256.txt.asc` and the release keys
(`gpg/pubring.kbx` from [nodejs/release-keys](https://github.com/nodejs/release-keys)). The file is clearsigned,
so verify the `.asc` alone and check the tarball against its output:

```bash
V=v22.23.4
curl -fsSLO https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz -O https://nodejs.org/dist/$V/SHASUMS256.txt.asc
gpgv --keyring ./pubring.kbx --output SHASUMS256.txt SHASUMS256.txt.asc
grep " node-$V-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf node-$V-linux-x64.tar.xz -C /opt
for b in node npm npx; do sudo ln -sf /opt/node-$V-linux-x64/bin/$b /usr/local/bin/$b; done
node -v
```

Updates are manual: the same steps with the new version, then new symlinks and `./scripts/deploy.sh`.

## 2. Install the server

```bash
sudo useradd --system --home-dir /var/lib/anyworld --shell /usr/bin/nologin anyworld   # /usr/sbin/nologin on Ubuntu
sudo git clone https://github.com/narve/any-world.git /opt/anyworld
sudo chown -R anyworld:anyworld /opt/anyworld
cd /opt/anyworld
sudo -u anyworld -H npm ci && sudo -u anyworld -H npm run build

sudo install -m 600 -o root -g root deploy/anyworld.env.example /etc/anyworld.env
sudoedit /etc/anyworld.env          # AI key(s), ANYWORLD_HOST_CODE, PORT
sudo cp deploy/anyworld.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now anyworld
curl http://127.0.0.1:8787/api/health
```

Logs: `journalctl -u anyworld -f`. Updates: `./scripts/deploy.sh` (pull, install, build, restart and
health check). It reads `PORT` from the root-only env file with sudo; a deploy user who may only restart the
service (no other sudo) passes it instead: `PORT=8787 ./scripts/deploy.sh`.

### Keep the laptop awake

In `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore`,
then `sudo systemctl restart systemd-logind`. Turn off automatic suspend in the desktop's power
settings. On a headless server, also mask the sleep targets:
`sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.

A machine with full-disk encryption and no automatic unlock stops at the passphrase prompt after a reboot
or a power cut, so the game is offline until someone types it.

## 3. Access code

With `ANYWORLD_HOST_CODE` set, the server makes every AI call from a browser (creating worlds, the
single-player game master, NPC voices) carry that code. The game master of a multiplayer room runs on
the server and needs no code (§7). Players enter it once in **Settings → Server access code**; it is kept in their
browser. Without it, demo worlds still play and "Surprise me" picks one, so strangers who find the
address cannot spend the API key. Wrong codes count against the per-IP rate limit
(`LLM_RATE_PER_MIN`, `LLM_RATE_BURST`).

Also set a spending limit on the provider key itself.

## 4. Reaching it from the internet

Decided: **WireGuard through the owner's VPS**, with the server on the Dell laptop at
`https://any-game.dv8.no` and the pages at `https://any.dv8.no` (see [the multiplayer plan, §4–5](MULTIPLAYER-PLAN.md#4-hosting)).
No port on the home router is opened in any option: with a tunnel on the same machine the server stays on
`HOST=127.0.0.1`; with a proxy elsewhere (the chosen setup) it listens on the tunnel and a firewall rule
admits only the proxy:

- **Tailscale Funnel:** `sudo tailscale funnel --bg 8787` gives `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel:** `cloudflared` routes a name such as `any-game.dv8.no` to `http://localhost:8787`.
- **WireGuard + VPS (chosen):** Caddy on the VPS serves `any-game.dv8.no` and proxies through the tunnel. Set
  `TRUST_PROXY=1` so rate limits see the real client address (required for rooms, §6: without it every
  player shares the proxy's address and its per-IP socket limit). A minimal Caddyfile (Caddy passes
  WebSocket upgrades through `reverse_proxy` without extra settings):

  ```
  any-game.dv8.no {
      reverse_proxy 10.88.0.4:8787
  }
  ```

  Here `10.88.0.4` is the Dell's WireGuard address (the VPS is `10.88.0.1`). The live setup uses
  `HOST=0.0.0.0` with UFW admitting only the VPS on the tunnel (`sudo ufw allow in on wg0 from 10.88.0.1 to
  any port 8787 proto tcp`): binding the tunnel address itself (`HOST=10.88.0.4`) fails at boot when the
  tunnel comes up after the service. Caddy on the VPS reaches the Dell as `10.88.0.1`; when it runs in
  Docker, its forwarding bypasses the VPS's UFW, so no rule is needed there. Expect bots: the name shows up in
  the certificate transparency logs, and scanners find it within seconds.

## 5. Web pages hosted elsewhere (optional)

The simplest setup is the one above: the server also serves the game's pages. To keep the pages on
GitHub Pages (at `any.dv8.no`) and only the server at home:

1. On the server: `ALLOWED_ORIGINS=https://any.dv8.no` (add `https://narve.github.io` while the old address is in use).
   The server's own pages (`https://any-game.dv8.no`) are always allowed and need not be listed.
2. Build the pages with the server's address: `ANYWORLD_SERVER_URL=https://any-game.dv8.no npm run build:static`.
   In the Pages workflow, set it as an environment variable on the build step. Without it, the pages are
   the offline demo, as now.
3. Both must be HTTPS: a page served over HTTPS cannot call an `http://` server.

When the laptop is off, such pages still load and play the demo worlds.

## 6. Multiplayer rooms (MP2)

The server also runs the multiplayer rooms (WebSocket on `/api/ws`, HTTP on `/api/rooms`).

- **Data directory.** Room files live in `<data dir>/rooms`: `ANYWORLD_DATA_DIR` when set (the env
  example sets `/var/lib/anyworld`), else `STATE_DIRECTORY` (systemd sets it from the unit's
  `StateDirectory=anyworld`), else `.data/` in the repo (gitignored; the development laptop). The server
  creates the directory at start-up and refuses to start if it cannot write there
  (`[server] cannot use data directory …` in `journalctl -u anyworld`). A restart replays each room's
  log; players reconnect with the token kept in their browser.
- **Limits.** 10 rooms (`ANYWORLD_MAX_ROOMS`), 8 players per room by default (the host may pick 2–12),
  idle rooms closed after 2 hours. Per client IP: 20 WebSocket connections a minute, 16 open at once,
  6 room creations per 10 minutes; 200 sockets in all. Behind Caddy, `TRUST_PROXY=1` is required.
- **Origins.** CORS does not cover WebSockets, so the server checks the `Origin` of every upgrade
  itself: pages served by the server itself (and the Vite dev proxy) may always connect, and with
  `ALLOWED_ORIGINS` set also those origins (e.g. `https://any.dv8.no`); any other origin is refused.
- **Deploy the pages and the server together.** Rooms compare the engine version (a hash of the
  engine source, `/api/health` reports it as `engine`): a page built from another engine is refused
  with a "reload the page" message, and a deploy that changes the engine closes the open rooms ("the
  server was updated"). So publish the Pages build and run `scripts/deploy.sh` at the same time.
- **Development.** `npm run dev` proxies `/api` (WebSocket included) to the API server, and the rooms
  use `.data/`. The engine version is computed when Vite and the server start, so after editing
  `src/engine`, `src/schema` or `src/net`, restart both (else the page is refused as outdated).
  Outside production, `ANYWORLD_ENGINE_VERSION` overrides the version and `ANYWORLD_TEST_TIMING` (JSON)
  the room durations; both are for the tests and ignored when `NODE_ENV=production`.
- **Graceful restart.** On SIGTERM (`systemctl restart`) every room saves a snapshot and tells its
  players to reconnect.
- **Trying a server with bots.** `npx tsx tools/room-bots.ts --url https://any-game.dv8.no --origin
  https://any.dv8.no --bots 4` creates a demo room and plays it with scripted clients (the engine
  version of the checkout must match the server's); `--room CODE` joins an existing room as guests.

## 7. The rooms' game master (MP4)

In a room the game master runs on the server, next to the room: the key stays on the server, and its
answers enter the room's log like every other input, so every player sees the same thing. Single
player is unchanged (the browser's own game master, with the server's provider or the player's key).

- **Opt-in.** `ANYWORLD_GM_PRESET` turns it on: a preset with a key in the env file (`mistral`,
  `anthropic`, `openai`, …). A key alone never does. Unset: demo rooms play their recorded lines and
  other rooms the canned offline lines. `off`: every room plays canned lines.
- **Every room**, also rooms made without the access code, gets the AI game master once it is on
  (making a new AI world still needs the code). The provider key's spending limit is the safeguard.
- **Model.** `ANYWORLD_GM_MODEL` sets the game master's model; by default it is the preset's cheap and
  fast one (`mistral-small-latest`, `claude-haiku-5-5`, `gpt-5-mini`), separate from the model that
  creates worlds (`<PRESET>_MODEL`, e.g. `MISTRAL_MODEL`; Mistral's default is `mistral-medium-latest`).
- **Nobody waits.** An answer later than `ANYWORLD_GM_TIMEOUT_MS` (5000) is dropped, and the room's
  canned lines answer instead. After 3 failed calls in a row a room uses its canned lines for 2 minutes.
  At most `ANYWORLD_GM_CONCURRENCY` calls run at once (default twice `ANYWORLD_MAX_ROOMS`), at most
  `ANYWORLD_GM_CALLS_PER_HOUR` (3000) in all and `ANYWORLD_GM_ROOM_CALLS_PER_HOUR` (400) per room.
- **Chat.** The game master reads the room's chat (the lobby says so) and may answer a line; chat
  lines are quoted to the model as data, and the same rule checks as in single player refuse anything
  unfair or game-breaking.
- **Logs.** One line per area with the calls, tokens and average latency (`gm area 1: 12 calls, …`),
  plus `gm breaker open` / `closed` and dropped answers. `/api/health` reports `gm: "ai"` or
  `"offline"`.
- **Trying a key.** `sudo npx tsx tools/gm-smoke.ts --preset mistral --calls 3 --env-file /etc/anyworld.env`
  sends 3 small game-master requests for a test party and prints latency, tokens and what the checks
  kept (at most 5 calls; it never prints the key). `sudo` because the env file is root-only (without it
  Node reports the file as "not found"). `--timeout` (default 5000) sets the limit the same way as
  `ANYWORLD_GM_TIMEOUT_MS`; `Request aborted` means a call hit it.
- **Timeout for Anthropic.** Through the home server, `claude-haiku-5-5` took 3.8–6.7 s per call
  (2026-10-30), so the default 4 s model deadline dropped most intro and idle answers. The live server runs
  `ANYWORLD_GM_TIMEOUT_MS=8000`. Measure with `--timeout 10000` before choosing a value.

## 8. Go-live checklist (Dell + VPS, `any.dv8.no` / `any-game.dv8.no`)

Done 2026-10-30/31 (steps 1–7 except the phone-on-4G session). The env file ended up with
`ALLOWED_ORIGINS` listing `https://any.dv8.no` and `https://narve.github.io`, `ANYWORLD_GM_PRESET=anthropic` and
`ANYWORLD_GM_TIMEOUT_MS=8000` (§7); the Pages build reads the repository variable `ANYWORLD_SERVER_URL`.

In this order; each step has a check. Verified locally on 2026-10-30 (production build, `npm start` with
`NODE_ENV=production`, a room of 4 bots from `https://any.dv8.no`, a refused foreign origin, rooms kept
across a SIGTERM restart, the Pages build carrying the server's engine version).

1. **Code on `main`.** The Pages workflow publishes `main` and the Dell's checkout pulls `main`, so
   server changes go there (the multiplayer edition was merged from `multi`, PR #2).
2. **Dell: install** as in §1–2 (patched Node.js, user `anyworld`, `/opt/anyworld`, `npm ci && npm run
   build`, the systemd unit). Check: `node -v` is a patched release; `systemctl status anyworld` is
   active; `curl -s http://127.0.0.1:8787/api/health` answers `ok` with an `engine` hash.
3. **Dell: `/etc/anyworld.env`** from `deploy/anyworld.env.example`: provider key(s) with a spending
   limit, `ANYWORLD_HOST_CODE` (long random), `HOST`/`PORT` for the WireGuard address (§4),
   `ALLOWED_ORIGINS=https://any.dv8.no`, `TRUST_PROXY=1`, `ANYWORLD_DATA_DIR=/var/lib/anyworld`, and for
   the AI game master in rooms `ANYWORLD_GM_PRESET=mistral` (or `anthropic`) with `ANYWORLD_GM_MODEL`
   left at the cheap default. Check: `npx tsx tools/gm-smoke.ts --preset mistral --calls 3 --env-file
   /etc/anyworld.env`, then `sudo systemctl restart anyworld` and `/api/health` shows `gm: "ai"`.
4. **WireGuard** Dell ↔ VPS (§4, `PersistentKeepalive`). Check: from the VPS,
   `curl http://<Dell WireGuard address>:8787/api/health`.
5. **VPS: Caddy** with the `any-game.dv8.no` block (§4; WebSockets need nothing extra). **DNS:** an A
   record `any-game` → the VPS. Check: `curl https://any-game.dv8.no/api/health` from anywhere.
6. **Pages:** a CNAME record `any` → `narve.github.io`; the repo's Pages settings → custom domain
   `any.dv8.no` (enforce HTTPS); Settings → Variables → `ANYWORLD_SERVER_URL=https://any-game.dv8.no`;
   then re-run the Pages workflow. Check: `https://any.dv8.no` loads, and its start page lists rooms
   (not "Rooms are unavailable").
7. **Rooms end to end.** From a checkout of the same commit:
   `npx tsx tools/room-bots.ts --url https://any-game.dv8.no --origin https://any.dv8.no --bots 4`
   ends with `[room-bots] ok room … hash=…`. Then MP0's exit check: open `https://any.dv8.no` on a phone
   on 4G, create a room, join it from a second device, chat, play.
8. **Updates later:** merge to `main` (the Pages workflow publishes it), then `./scripts/deploy.sh` on
   the Dell at the same time (§6: pages and server must share the engine version; open rooms close with
   "the server was updated" when the engine changed).

What stays open after go-live (docs/progress/MP.md): the latency playtest through this path and a
session with real people.
