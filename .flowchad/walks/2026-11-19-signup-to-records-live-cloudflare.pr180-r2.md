# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:12:42.870Z
- **Target:** http://127.0.0.1:8861 (local-copy)
- **Commit:** ebc21c7879073932f31cbe0fe7b75b131e2a172b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: S2 asks who you are and whose email it is, plus two optional questions; step 5: S4 asks the domain and then the setup choice on the same screen; step 3: decisions = 2, needs decisions <= 1; step 5: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 3: the optional role and where-did-you-hear questions stay on S2

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 9 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 522 |  |
| `reading_time_to_value_s` | — | 132 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1824 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 15838 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
