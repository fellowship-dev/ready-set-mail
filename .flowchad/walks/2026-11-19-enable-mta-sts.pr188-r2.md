# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-19T21:08:38.338Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** 984d3336d66ea68877c96de5ed27359c96aae3b9
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
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 429 |  |
| `reading_time_to_value_s` | — | 108 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 851 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6062 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
