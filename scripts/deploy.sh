#!/usr/bin/env bash
# Update and restart the AnyWorld server on the host (docs/HOSTING.md).
# Run from the checkout (default /opt/anyworld) as a user who may sudo:  ./scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/anyworld}"
SERVICE="${SERVICE:-anyworld}"
RUN_AS="${RUN_AS:-anyworld}"
PORT="${PORT:-$(sudo sed -n 's/^PORT=//p' /etc/anyworld.env 2>/dev/null | tail -1)}"
PORT="${PORT:-8787}"

cd "$APP_DIR"
as_app() { sudo -u "$RUN_AS" -H "$@"; }

echo "== Node.js runtime: $(as_app node -v)"
# npm ci refuses runtimes outside package.json "engines" (.npmrc engine-strict), and the server refuses
# them again at startup: Node.js with the CVE-2026-111497 (HTTP2Shell) fix only, see server/node-check.ts

echo "== Fetching the latest code"
as_app git pull --ff-only

echo "== Installing dependencies and building"
as_app npm ci --no-audit --no-fund || { echo "npm ci failed; if it names the Node.js engine, upgrade Node.js first (docs/HOSTING.md: the nodejs.org build, or your distribution's patched LTS package)"; exit 1; }
as_app npm run build

echo "== Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "== Health check"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo
    echo "Deployed $(as_app git rev-parse --short HEAD)."
    exit 0
  fi
  sleep 1
done
echo "The server did not answer on port ${PORT}; see: journalctl -u ${SERVICE} -n 50"
exit 1
