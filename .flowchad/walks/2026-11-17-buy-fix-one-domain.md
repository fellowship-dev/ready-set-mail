# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered - the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-16T09:06:03.777Z
- **Target:** http://127.0.0.1:8865 (local-copy)
- **Commit:** ff6f51c67d639c28b94fc9d1e4b5b1eb7d440400
- **Kind:** screens
- **Gate:** PASS-WITH-OVERRIDES
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready only with overrides: blocker rules failed and were overridden. Tell the tester about every override below first, and fix them next.

### Known rough edges (1)

- **FOLD-01** (blocker, **OVERRIDDEN** by coordinator on 2026-11-16) The first input is visible without scrolling — failed: step 1 @375: the offer's button ends 0.63 screens below the top at 375 on the domain page; the confirm steps are inside the first screen; step 1 @375: scroll_before_primary_vh = 0.63, needs scroll_before_primary_vh = 0; accepted because: the offer sits 0.63 screens below the fold at 375 on main already; this PR does not change that layout

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 605 |  |
| `reading_time_to_value_s` | — | 153 |  |
| `max_scroll_before_primary_vh` | — | 375: 0.63 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1377 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 17517 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
