# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address
- **Walked:** 2026-11-16T06:12:47+00:00
- **Target:** http://127.0.0.1:8841 (local-copy)
- **Commit:** 4e428ecb8caaa8b194e4c8501b0e5d8d37d3dcbd
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
| `screens_to_value` | — | 9 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 9 |  |
| `words_to_value` | — | 942 |  |
| `reading_time_to_value_s` | — | 237 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 3935 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 18521 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
