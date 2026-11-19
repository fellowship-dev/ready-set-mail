# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report: the live DMARC record lists the shared report address and the domain is connected (the status API says waiting)
- **Walked:** 2026-11-19T21:12:06.453Z
- **Target:** http://127.0.0.1:8871 (local-copy)
- **Commit:** ebc21c7879073932f31cbe0fe7b75b131e2a172b
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
| `screens_to_value` | — | 3 |  |
| `decisions_to_value` | — | 2 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 730 |  |
| `reading_time_to_value_s` | — | 184 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 944 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 1358 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
