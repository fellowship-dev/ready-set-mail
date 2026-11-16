#!/usr/bin/env bash
# Protected value flows (ADR 0012): fail a change that touches a protected flow without a new walk record or a reviewed
# "not affected" record. The rules and the record formats are in scripts/check-flows.mjs; AGENTS.md rule 5 says what to do.
#
#   bash scripts/check-flows.sh [<base ref>]     # default base: the merge base with origin/main
#
# Exit: 0 nothing to do, 1 a protected flow changed without a valid record, 2 usage.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
exec node scripts/check-flows.mjs "$@"
