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

Not decided yet; see [the multiplayer plan, §4](MULTIPLAYER-PLAN.md#4-hosting-on-the-laptop-cachyos).
In every option the server stays on `HOST=127.0.0.1` and the tunnel or proxy connects to it, so no
port on the home router is opened:

- **Tailscale Funnel:** `sudo tailscale funnel --bg 8787` gives `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel:** `cloudflared` routes a name such as `play.dv8.no` to `http://localhost:8787`.
- **WireGuard + VPS:** Caddy on the VPS serves `play.dv8.no` and proxies through the tunnel. Set
  `TRUST_PROXY=1` so rate limits see the real client address. A minimal Caddyfile:

  ```
  play.dv8.no {
      reverse_proxy 10.66.0.2:8787
  }
  ```

  Here `10.66.0.2` is the laptop's WireGuard address. On the laptop, the server must then listen on that
  address (`HOST=10.66.0.2`) or on `0.0.0.0` with a firewall rule that allows only the tunnel.

## 5. Web pages hosted elsewhere (optional)

The simplest setup is the one above: the server also serves the game's pages. To keep the pages on
GitHub Pages (for example at `anyworld.dv8.no`) and only the server at home:

1. On the server: `ALLOWED_ORIGINS=https://anyworld.dv8.no` (or `https://narve.github.io`).
2. Build the pages with the server's address: `ANYWORLD_SERVER_URL=https://play.dv8.no npm run build:static`.
   In the Pages workflow, set it as an environment variable on the build step. Without it, the pages are
   the offline demo, as now.
3. Both must be HTTPS: a page served over HTTPS cannot call an `http://` server.

When the laptop is off, such pages still load and play the demo worlds.
