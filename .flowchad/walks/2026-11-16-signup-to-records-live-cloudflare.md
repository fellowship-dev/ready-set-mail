# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address (the operator workspace is admitted to reports)
- **Walked:** 2026-11-16T07:16:16+00:00
- **Target:** http://127.0.0.1:8841 (local-copy)
- **Commit:** 529fc707b72d6c02fef711ec1648f27a9e144161
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
| `words_to_value` | — | 1138 |  |
| `reading_time_to_value_s` | — | 287 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 3471 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13631 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
