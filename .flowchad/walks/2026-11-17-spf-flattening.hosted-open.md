# Walk record: spf-flattening

- **Flow:** Owner of a domain with too many SPF lookups turns on flattening and it stays correct (hosted, add-on not admitted)
- **Value moment:** The step leads to a page that counts where the lookups go and what to do by hand, and the typed flattening address says plainly it is not available
- **Walked:** 2026-11-17T02:55:24.741Z
- **Target:** http://127.0.0.1:8903 (local-copy)
- **Commit:** 5e243dc
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (0)

- none found by the rules

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 2 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 1 |  |
| `words_to_value` | — | 553 |  |
| `reading_time_to_value_s` | — | 139 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 849 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4412 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
- Walked with the committed script `e2e/support/spf-flattening-walk.mjs`: `WALK_OUT=<dir> node e2e/support/spf-flattening-walk.mjs hosted-open` (after `npm run build:dashboard`); every number above comes from its results.json.
- Gated with the repo's gate: `node .agents/skills/flow-gate/scripts/gate.mjs <WALK_OUT>/results.json --target http://127.0.0.1:8903 --record .flowchad/walks`; this file is that record, with the two lines of notes about the script added by hand.
