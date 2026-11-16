# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered - the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-16T06:17:47+00:00
- **Target:** http://127.0.0.1:8841 (local-copy)
- **Commit:** e98ef3a6e708a1881085c2e5db3c54ca5d909886
- **Kind:** screens
- **Gate:** FAIL
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Not ready: do not hand this to a human tester until these pass.

- blocker FOLD-01 failed: The first input is visible without scrolling

### Blockers failed

- **FOLD-01** The first input is visible without scrolling — step 1 @375: scroll_before_primary_vh = 1.14, needs scroll_before_primary_vh = 0; step 1 @1440: scroll_before_primary_vh = 0.25, needs scroll_before_primary_vh = 0

### Known rough edges (0)

- none found by the rules

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 1866 |  |
| `reading_time_to_value_s` | — | 470 |  |
| `max_scroll_before_primary_vh` | — | 375: 1.14 · 1440: 0.25 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1314 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13055 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
