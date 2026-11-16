# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address (the operator workspace is admitted to reports)
- **Walked:** 2026-11-16T06:16:24+00:00
- **Target:** http://127.0.0.1:8841 (local-copy)
- **Commit:** e98ef3a6e708a1881085c2e5db3c54ca5d909886
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
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1191 |  |
| `reading_time_to_value_s` | — | 300 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 3467 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 12135 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
