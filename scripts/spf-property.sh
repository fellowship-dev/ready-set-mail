#!/usr/bin/env bash
# The long run of the SPF flattening property test (packages/dns-checks/test/spf-flatten.property.test.ts).
#
#   bash scripts/spf-property.sh [trees] [summary.json] [first seed]     # default: 50000 trees, spf-property-summary.json, seed 1
#
# Each tree is flattened in four modes and every result is compared with an independent RFC 7208 evaluator for many senders. CI runs 2,000
# trees in `npm test`; this is the same test with more of them. Exit: 0 no failure, 1 a failure (the summary has the first examples).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
trees="${1:-50000}"
out="${2:-spf-property-summary.json}"
seed="${3:-1}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
PROP_TREES="$trees" PROP_OUT="$out" PROP_SEED_START="$seed" npx vitest run --config vitest.node.config.mts packages/dns-checks/test/spf-flatten.property.test.ts
code=$?
if [ -f "$out" ]; then node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({trees:s.trees,seedStart:s.seedStart,stats:s.stats,refusedKinds:s.refusedKinds,failureKinds:s.failureKinds}))' "$out"; fi
exit $code
