# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live: ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T23:11:49.220Z
- **Target:** http://127.0.0.1:8862 (local-copy)
- **Commit:** 2ef1aafb3feb8c4601aaec831ff16806f3b3208b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name and organisation, whose email it is, and two optional questions: decisions = 2; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: the optional role and "where did you hear about us" questions stay on S2
- **NOISE-01** (should-fix) Everything visible serves the step — step 8: after Apply the dashboard lists every imported domain with its own state: brightwave-mail.com "Needs attention ... Check the spelling, or remove this domain" and quietfield.net sit beside the one domain being set up

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 9 |  |
| `fields_to_value` | — | 13 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 730 |  |
| `reading_time_to_value_s` | — | 184 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 14 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 6530 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 88192 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Two domains the person did not choose to work on (other zones of the same Cloudflare account) appear above and below the one just fixed, one flagged "Needs attention" only because the invented name does not exist in public DNS

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
