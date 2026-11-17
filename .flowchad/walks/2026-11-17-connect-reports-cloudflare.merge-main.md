# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report - the live DMARC record lists the shared report address and the domain is connected (GET /api/domains/:id/report-address says waiting); only for a workspace HOSTED_CONNECT_REPORTS admits
- **Walked:** 2026-11-17T12:29:32.102Z
- **Target:** http://127.0.0.1:8931 (local-copy)
- **Commit:** 7911d9e
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: besides what the step needs: policy badge; Analytics and Settings buttons; the Do this next list (a DKIM item, and a second Connect reports item); step 2: besides what the step needs: policy badge; Analytics and Settings buttons; the Do this next list under the review; step 3: besides what the step needs: policy badge; Analytics and Settings buttons; the Do this next list under the panel

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 3 |  |
| `decisions_to_value` | — | 2 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 644 |  |
| `reading_time_to_value_s` | — | 162 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 946 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 3051 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
