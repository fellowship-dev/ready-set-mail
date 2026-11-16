#!/usr/bin/env bash
# Protected value flows: fail when a change touches a page on a saved flow and brings no fresh walk record for it.
#
#   bash scripts/check-flows.sh [<base ref>]     # default base: the merge base with origin/main
#
# A protected flow is a .flowchad/flows/<id>.yml whose `tags:` include `protected`. FlowChad's changed.sh
# (.agents/skills/flow-gate/scripts/changed.sh) says which flows the change touches since <base>: its `covers:` globs,
# the flow file and the flow map. For each protected flow it marks `walk`, this change must also add or update
# .flowchad/walks/<date>-<id>.md (the walk record `/flow-gate <id> --record .flowchad/walks` writes, reviewed).
#
# CI cannot walk a flow (that needs a browser and a judge), so it checks the record instead of making one.
# Exit: 0 nothing to re-walk, 1 a protected flow changed without a walk record, 2 usage.
set -u

CHANGED=.agents/skills/flow-gate/scripts/changed.sh
[ -f "$CHANGED" ] || { echo "check-flows: $CHANGED is missing (FlowChad flow-gate skill)" >&2; exit 2; }

BASE="${1:-}"
if [ -z "$BASE" ]; then
  BASE=$(git merge-base HEAD origin/main 2>/dev/null) || { echo "check-flows: no base: pass a ref or fetch origin/main" >&2; exit 2; }
fi
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "check-flows: unknown base: $BASE" >&2; exit 2; }

walked=$( { git diff --name-only "$BASE" -- .flowchad/walks; git ls-files --others --exclude-standard -- .flowchad/walks; } | sort -u)
missing=0
while IFS="$(printf '\t')" read -r verdict id reason; do
  [ -n "${id:-}" ] || continue
  flow=".flowchad/flows/$id.yml"
  grep -Eq '^tags:.*[[, ]protected[], ]' "$flow" 2>/dev/null || continue
  if [ "$verdict" = walk ]; then
    if printf '%s\n' "$walked" | grep -Eq "^\.flowchad/walks/[0-9]{4}-[0-9]{2}-[0-9]{2}-$id\.md$"; then
      echo "ok     $id: re-walked ($reason)"
    else
      echo "REWALK $id: $reason, and no .flowchad/walks/*-$id.md in this change"
      missing=1
    fi
  elif [ "$verdict" = maybe ]; then
    echo "maybe  $id: $reason (not enforced; read it)"
  fi
done < <(bash "$CHANGED" --base "$BASE")

if [ "$missing" = 1 ]; then
  cat >&2 <<'EOF'

A page on a protected value flow changed. Walk the flow again on a local copy of this commit and commit the record:
  /flow-walk <id>  then  /flow-gate <id> --target <url> --record .flowchad/walks
If the flow itself changed, update .flowchad/flows/<id>.map.md first (map before building). See AGENTS.md.
EOF
  exit 1
fi
echo "check-flows: no protected flow needs a new walk since $(git rev-parse --short "$BASE")"
