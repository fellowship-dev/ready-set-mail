# Walk record: spf-flattening

- **Flow:** Owner of a domain with too many SPF lookups turns on flattening and it stays correct
- **Value moment:** Flattening is on - the record lists the sender addresses directly, within 10 lookups and 450 bytes, and the daily check keeps it current or says why it could not
- **Walked:** 2026-11-17T02:53:04.959Z
- **Target:** http://127.0.0.1:8902 (local-copy)
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
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 3 |  |
| `words_to_value` | — | 745 |  |
| `reading_time_to_value_s` | — | 188 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 855 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7973 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
- Walked with the committed script `e2e/support/spf-flattening-walk.mjs`: `WALK_OUT=<dir> node e2e/support/spf-flattening-walk.mjs hosted-admitted` (after `npm run build:dashboard`); every number above comes from its results.json (steps 9 and 13 are the review screen and the delete dialog that stops).
- Gated with the repo's gate: `node .agents/skills/flow-gate/scripts/gate.mjs <WALK_OUT>/results.json --target http://127.0.0.1:8902 --record .flowchad/walks`; this file is that record, with the two lines of notes about the script added by hand.
