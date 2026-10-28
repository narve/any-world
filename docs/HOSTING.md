# Hosting AnyWorld at home

How to run the AnyWorld server on a spare Linux machine (written for CachyOS / Arch; other systemd
distributions work the same way) and make it reachable from the internet. This is milestone MP0 of
[the multiplayer plan](MULTIPLAYER-PLAN.md). It is useful for the single-player game already.

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

## 2. Install the server

```bash
sudo useradd --system --home-dir /var/lib/anyworld --shell /usr/bin/nologin anyworld
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
health check).

### Keep the laptop awake

In `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore`,
then `sudo systemctl restart systemd-logind`. Turn off automatic suspend in the desktop's power
settings.

## 3. Access code

With `ANYWORLD_HOST_CODE` set, the server makes every AI call (creating worlds, the game master, NPC
voices) carry that code. Players enter it once in **Settings → Server access code**; it is kept in their
browser. Without it, demo worlds still play and "Surprise me" picks one, so strangers who find the
address cannot spend the API key. Wrong codes count against the per-IP rate limit
(`LLM_RATE_PER_MIN`, `LLM_RATE_BURST`).

Also set a spending limit on the provider key itself.

## 4. Reaching it from the internet

Decided: **WireGuard through the owner's VPS**, with the server on the Dell laptop at
`https://any-game.dv8.no` and the pages at `https://any.dv8.no` (see [the multiplayer plan, §4–5](MULTIPLAYER-PLAN.md#4-hosting)).
In every option the server stays on `HOST=127.0.0.1` and the tunnel or proxy connects to it, so no
port on the home router is opened:

- **Tailscale Funnel:** `sudo tailscale funnel --bg 8787` gives `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel:** `cloudflared` routes a name such as `any-game.dv8.no` to `http://localhost:8787`.
- **WireGuard + VPS (chosen):** Caddy on the VPS serves `any-game.dv8.no` and proxies through the tunnel. Set
  `TRUST_PROXY=1` so rate limits see the real client address (required for rooms, §6: without it every
  player shares the proxy's address and its per-IP socket limit). A minimal Caddyfile (Caddy passes
  WebSocket upgrades through `reverse_proxy` without extra settings):

  ```
  any-game.dv8.no {
      reverse_proxy 10.66.0.2:8787
  }
  ```

  Here `10.66.0.2` is the laptop's WireGuard address. On the laptop, the server must then listen on that
  address (`HOST=10.66.0.2`) or on `0.0.0.0` with a firewall rule that allows only the tunnel.

## 5. Web pages hosted elsewhere (optional)

The simplest setup is the one above: the server also serves the game's pages. To keep the pages on
GitHub Pages (at `any.dv8.no`) and only the server at home:

1. On the server: `ALLOWED_ORIGINS=https://any.dv8.no` (add `https://narve.github.io` while the old address is in use).
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
  itself: with `ALLOWED_ORIGINS` set only those origins may connect (e.g. `https://any.dv8.no`); with
  it empty only pages served by the server itself (and the Vite dev proxy) may.
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
