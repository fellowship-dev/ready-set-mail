# Walk record: spf-flattening

- **Flow:** Owner of a domain with too many SPF lookups turns on flattening and it stays correct (hosted, add-on not admitted)
- **Value moment:** The step leads to a page that counts where the lookups go and what to do by hand, and the typed flattening address says plainly it is not available
- **Walked:** 2026-11-17T00:36:07.321Z
- **Target:** http://127.0.0.1:8903 (local-copy)
- **Commit:** 7f47f43
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
| `longest_wait_ms` | — | 832 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4190 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
