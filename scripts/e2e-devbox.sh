#!/usr/bin/env bash
# Run the Playwright end-to-end suite against throwaway local Workers, inside a devbox or a Linux CI machine
# (not a workstation: it builds, may install a browser and serves the app).
#
#   bash scripts/e2e-devbox.sh                    # every spec file in e2e/
#   bash scripts/e2e-devbox.sh e2e/analytics.spec.ts e2e/workspaces.spec.ts
#
# From a checkout after `npm ci`, it builds the dashboard once (skip with E2E_SKIP_BUILD=1), then runs each spec
# file against its own brand-new instance, because several specs start from a fresh installation (the first
# sign-in creates the owner; "first-run setup" expects no domain yet). For each file:
#   - a freshly migrated local D1, a random first-owner proof and operator login in private 0600 files;
#   - `wrangler dev --local-protocol https` on E2E_PORT (default 8799, so a devbox's own `wrangler dev` on 8787
#     can keep running), with BETTER_AUTH_URL set to that HTTPS origin and MCP_DCR_ENABLED=1 (the agent spec
#     registers a client), from a temporary copy of wrangler.jsonc whose rate limits are raised so a fast run
#     is not throttled (wrangler.jsonc itself is not changed);
#   - Playwright with one worker; the first sign-in's cookies are saved to a private file and reused by the
#     file's later tests, so the product's per-IP sign-in limit is never met.
# It ends with a per-spec summary and exits non-zero when any test failed. Every Worker's process group is
# stopped and every temporary file removed, also on Ctrl-C.
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  echo "scripts/e2e-devbox.sh runs in a devbox or Linux CI, not on a workstation. Start a devbox and run it there." >&2
  exit 2
fi

cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8799}"
ORIGIN="https://127.0.0.1:$PORT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rsm-e2e-XXXXXX")"
chmod 700 "$WORK"
mkdir -p "$WORK/tmp"
WRANGLER_PID=""
STARTED=$(date +%s)

stop_worker() {
  # wrangler dev runs in its own process group (setsid): stop the whole group, workerd included.
  if [ -n "$WRANGLER_PID" ]; then
    kill -TERM -- "-$WRANGLER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$WRANGLER_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$WRANGLER_PID" 2>/dev/null || true
    WRANGLER_PID=""
  fi
}
cleanup() {
  stop_worker
  if [ -z "${E2E_KEEP:-}" ]; then rm -rf "$WORK"; else echo "kept: $WORK"; fi
}
trap cleanup EXIT INT TERM

port_free() { node -e "const s=require('node:net').createServer().once('error',()=>process.exit(1)).listen($PORT,'127.0.0.1',()=>s.close(()=>process.exit(0)))"; }
# The local certificate is self-signed: this probe skips verification (Playwright is told the same via E2E_IGNORE_HTTPS_ERRORS).
healthy() { NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('$ORIGIN/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; }

if [ ! -d node_modules/wrangler ] || [ ! -d node_modules/@playwright/test ]; then
  echo "Dependencies are missing: run npm ci first." >&2
  exit 2
fi
if ! port_free; then
  echo "Port $PORT is already in use. Choose a free one with E2E_PORT, for example E2E_PORT=$((PORT + 11)) $0" >&2
  exit 2
fi

# The spec files: the arguments, or every file Playwright's testMatch (**/*.spec.ts) picks up in e2e/.
if [ "$#" -gt 0 ]; then SPECS=("$@"); else mapfile -t SPECS < <(ls e2e/*.spec.ts); fi

if [ -z "${E2E_SKIP_BUILD:-}" ]; then
  echo "Building the dashboard"
  npm run build:dashboard > "$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log" >&2; exit 1; }
fi

if [ -z "$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium* 2>/dev/null)" ]; then
  echo "Installing the Playwright browser (chromium)"
  npx playwright install chromium > "$WORK/browser.log" 2>&1 || { tail -20 "$WORK/browser.log" >&2; exit 1; }
fi
if ! TMPDIR="$WORK/tmp" node -e "require('@playwright/test').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))" > "$WORK/launch.log" 2>&1; then
  echo "Chromium cannot start on this machine (usually missing system libraries such as libglib-2.0)." >&2
  echo "Install them once as root (npx playwright install-deps chromium), or use a devbox image that has them, then run this again." >&2
  exit 2
fi

# The e2e Worker's own config: the tracked wrangler.jsonc with absolute paths and its rate limits raised.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { resolve } from "node:path";
  import { parseJsonc } from "./scripts/setup/config.mjs";
  const cfg = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  cfg.main = resolve(cfg.main);
  cfg.assets.directory = resolve(cfg.assets.directory);
  for (const d of cfg.d1_databases) d.migrations_dir = resolve(d.migrations_dir);
  delete cfg.build;
  for (const b of cfg.unsafe?.bindings ?? []) if (b.type === "ratelimit") b.simple.limit = 100000;
  writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));
' "$WORK/wrangler.e2e.json"

FAILED=0
n=0
for spec in "${SPECS[@]}"; do
  n=$((n + 1))
  RUN="$WORK/run-$n"
  mkdir -p "$RUN"
  echo ""
  echo "[$n/${#SPECS[@]}] $spec: fresh instance at $ORIGIN"
  node packages/db/scripts/migrate.mjs --local --persist-to "$RUN/d1" > "$RUN/migrate.log" 2>&1 || { tail -20 "$RUN/migrate.log" >&2; exit 1; }
  (umask 077; node -e '
    const c = require("node:crypto"), fs = require("node:fs");
    const proof = c.randomBytes(32).toString("hex");
    fs.writeFileSync(process.argv[1], JSON.stringify({ email: "e2e-owner@example.test", password: c.randomBytes(18).toString("base64url"), proof }), { mode: 0o600 });
    fs.writeFileSync(process.argv[2], `BOOTSTRAP_SECRET=${proof}\nBETTER_AUTH_URL=${process.argv[3]}\nMCP_DCR_ENABLED=1\n`, { mode: 0o600 });
  ' "$RUN/operator.json" "$RUN/dev.env" "$ORIGIN")

  TMPDIR="$WORK/tmp" setsid npx wrangler dev --config "$WORK/wrangler.e2e.json" --local --persist-to "$RUN/d1" --ip 127.0.0.1 --port "$PORT" --local-protocol https --env-file "$RUN/dev.env" < /dev/null > "$RUN/wrangler.log" 2>&1 &
  WRANGLER_PID=$!
  for _ in $(seq 1 90); do
    if healthy; then break; fi
    if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then echo "wrangler dev exited:" >&2; tail -20 "$RUN/wrangler.log" >&2; exit 1; fi
    sleep 2
  done
  healthy || { echo "/health did not answer within 3 minutes:" >&2; tail -20 "$RUN/wrangler.log" >&2; exit 1; }

  set +e
  TMPDIR="$WORK/tmp" E2E_BASE_URL="$ORIGIN" E2E_IGNORE_HTTPS_ERRORS=1 E2E_PERSIST_TO="$RUN/d1" \
    E2E_OPERATOR_FILE="$RUN/operator.json" E2E_SESSION_FILE="$RUN/session.json" \
    PLAYWRIGHT_JSON_OUTPUT_NAME="$RUN/results.json" \
    npx playwright test --workers=1 --reporter=list,json --output="$RUN/test-results" "$spec"
  [ $? -eq 0 ] || FAILED=1
  set -e
  stop_worker
  for _ in $(seq 1 15); do port_free && break; sleep 1; done
done

echo ""
echo "Per spec:"
node -e '
  const fs = require("node:fs");
  const total = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  let files = 0;
  for (const [i, spec] of process.argv.slice(2).entries()) {
    const row = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
    let r = null;
    try { r = JSON.parse(fs.readFileSync(`${process.argv[1]}/run-${i + 1}/results.json`, "utf8")); } catch {}
    const walk = (suite) => {
      for (const s of suite.specs ?? []) for (const t of s.tests ?? []) row[t.status === "expected" ? "passed" : t.status === "unexpected" ? "failed" : t.status] += 1;
      for (const c of suite.suites ?? []) walk(c);
    };
    if (r) for (const s of r.suites ?? []) walk(s); else row.failed += 1;
    files += 1;
    for (const k in total) total[k] += row[k];
    console.log(`  ${row.failed ? "FAIL" : "ok  "}  ${spec.padEnd(42)} ${r ? `${row.passed} passed` : "no results"}${row.failed && r ? `, ${row.failed} failed` : ""}${row.skipped ? `, ${row.skipped} skipped` : ""}${row.flaky ? `, ${row.flaky} flaky` : ""}`);
  }
  console.log(`  total: ${files} spec files, ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped, ${total.flaky} flaky`);
' "$WORK" "${SPECS[@]}"
echo "  time: $(( $(date +%s) - STARTED )) s"
exit "$FAILED"
