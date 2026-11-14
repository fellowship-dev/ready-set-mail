#!/usr/bin/env bash
# Run the Playwright end-to-end suite against a throwaway local Worker, inside a devbox or a Linux CI
# machine (not a workstation: it builds, installs a browser and serves the app).
#
#   scripts/e2e-devbox.sh                    # every spec in e2e/
#   scripts/e2e-devbox.sh e2e/analytics.spec.ts
#
# What it does, from a checkout after `npm ci`:
#   1. builds the dashboard (skip with E2E_SKIP_BUILD=1 when web/dist is current);
#   2. migrates a fresh local D1 in a temporary folder (E2E_PERSIST_TO);
#   3. writes a random first-owner proof and operator login to private 0600 files (never printed);
#   4. starts `wrangler dev` on E2E_PORT (default 8787; it stops if the port is taken) with that proof and waits for /health;
#   5. runs `playwright test` with E2E_PERSIST_TO and E2E_OPERATOR_FILE set, then stops the Worker and
#      removes the temporary files. The exit code is Playwright's.
# The first spec to sign in creates the owner through /api/auth/setup with the proof, as a person would.
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  echo "scripts/e2e-devbox.sh runs in a devbox or Linux CI, not on a workstation. Start a devbox and run it there." >&2
  exit 2
fi

cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8787}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rsm-e2e-XXXXXX")"
chmod 700 "$WORK"
PERSIST="${E2E_PERSIST_TO:-$WORK/d1}"
OPERATOR="$WORK/operator.json"
ENV_FILE="$WORK/dev.env"
LOG="$WORK/wrangler.log"
WRANGLER_PID=""

cleanup() {
  # wrangler dev runs in its own process group (setsid): stop the whole group, workerd included.
  if [ -n "$WRANGLER_PID" ]; then
    kill -TERM -- "-$WRANGLER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 -- "-$WRANGLER_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$WRANGLER_PID" 2>/dev/null || true
  fi
  if [ -z "${E2E_KEEP:-}" ]; then rm -rf "$WORK"; else echo "kept: $WORK"; fi
}
trap cleanup EXIT INT TERM

if [ ! -d node_modules/wrangler ] || [ ! -d node_modules/@playwright/test ]; then
  echo "Dependencies are missing: run npm ci first." >&2
  exit 2
fi

if ! node -e "const s=require('node:net').createServer().once('error',()=>process.exit(1)).listen($PORT,'127.0.0.1',()=>s.close(()=>process.exit(0)))"; then
  echo "Port $PORT is already in use (a devbox's own wrangler dev, for example). Choose a free one with E2E_PORT, for example E2E_PORT=$((PORT + 11)) $0" >&2
  exit 2
fi

if [ -z "${E2E_SKIP_BUILD:-}" ]; then
  echo "[1/5] Building the dashboard"
  npm run build:dashboard > "$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log" >&2; exit 1; }
else
  echo "[1/5] Using the existing dashboard build (E2E_SKIP_BUILD)"
fi

echo "[2/5] Migrating a fresh local database in $PERSIST"
rm -rf "$PERSIST"
node packages/db/scripts/migrate.mjs --local --persist-to "$PERSIST" > "$WORK/migrate.log" 2>&1 || { tail -20 "$WORK/migrate.log" >&2; exit 1; }

echo "[3/5] Writing a private operator login and first-owner proof"
(umask 077; node -e '
  const c = require("node:crypto"), fs = require("node:fs");
  const proof = c.randomBytes(32).toString("hex");
  fs.writeFileSync(process.argv[1], JSON.stringify({ email: "e2e-owner@example.test", password: c.randomBytes(18).toString("base64url"), proof }), { mode: 0o600 });
  fs.writeFileSync(process.argv[2], "BOOTSTRAP_SECRET=" + proof + "\n", { mode: 0o600 });
' "$OPERATOR" "$ENV_FILE")

echo "[4/5] Starting the Worker on :$PORT"
setsid npx wrangler dev --local --persist-to "$PERSIST" --ip 127.0.0.1 --port "$PORT" --env-file "$ENV_FILE" < /dev/null > "$LOG" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then break; fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then echo "wrangler dev exited:" >&2; tail -20 "$LOG" >&2; exit 1; fi
  sleep 2
done
node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || { echo "/health did not answer within 3 minutes:" >&2; tail -20 "$LOG" >&2; exit 1; }

if ! npx playwright test --list > /dev/null 2>&1 || [ -z "$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium* 2>/dev/null)" ]; then
  echo "      installing the Playwright browser (chromium)"
  npx playwright install chromium > "$WORK/browser.log" 2>&1 || { tail -20 "$WORK/browser.log" >&2; exit 1; }
fi

if ! node -e "require('@playwright/test').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))" > "$WORK/launch.log" 2>&1; then
  echo "Chromium cannot start on this machine: its system libraries are missing ($(grep -o 'lib[a-z0-9_.+-]*\.so[.0-9]*' "$WORK/launch.log" | head -1))." >&2
  echo "Install them once as root (npx playwright install-deps chromium), or use a devbox image that has them, then run this again." >&2
  exit 2
fi

echo "[5/5] Running Playwright"
set +e
E2E_BASE_URL="http://127.0.0.1:$PORT" E2E_PERSIST_TO="$PERSIST" E2E_OPERATOR_FILE="$OPERATOR" npx playwright test "$@"
STATUS=$?
set -e
exit "$STATUS"
