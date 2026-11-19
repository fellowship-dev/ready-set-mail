# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:45:39.535Z
- **Target:** http://127.0.0.1:8874 (local-copy)
- **Commit:** e20591f6efbec22737ea38b18f69dd9bf42d1076
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1; step 2: decisions = 5, needs decisions <= 1
- **WAIT-01** (should-fix) Show status for waits of 2 seconds or more — step 8: wait_feedback = false with wait_ms = 60807, needs wait_feedback = true when wait_ms >= 2000
- **WAIT-02** (should-fix) Show progress and an estimate for waits over 10 seconds — step 8: wait_progress = false with wait_ms = 60807, needs wait_progress = true when wait_ms > 10000

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 10 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 564 |  |
| `reading_time_to_value_s` | — | 142 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 60807 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 79649 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
