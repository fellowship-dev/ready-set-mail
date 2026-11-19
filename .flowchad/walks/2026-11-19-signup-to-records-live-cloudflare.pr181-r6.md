# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:09:47.493Z
- **Target:** http://127.0.0.1:8874 (local-copy)
- **Commit:** 25ce01b5181d11f18342497a02c06ecdae25032a
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1; step 2: decisions = 5, needs decisions <= 1
- **WAIT-01** (should-fix) Show status for waits of 2 seconds or more — step 8: wait_feedback = false with wait_ms = 60996, needs wait_feedback = true when wait_ms >= 2000

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 10 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 587 |  |
| `reading_time_to_value_s` | — | 148 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 60996 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 77409 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After Apply the first-day card stayed on "waiting for public DNS to show the new record" for 61 s before it flipped, although the DNS answer (the fake) carried the record from the first second; the card says it looks again every 15 seconds

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
