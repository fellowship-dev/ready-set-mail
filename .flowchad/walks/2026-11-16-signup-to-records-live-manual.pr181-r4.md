# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live: ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T23:44:27.647Z
- **Target:** http://127.0.0.1:8861 (local-copy)
- **Commit:** 7118757d6fb6151f1c7b39dd15a8338aa476fa8f
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (4)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name and organisation, whose email it is, and two optional questions: decisions = 2; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: the optional role and "where did you hear about us" questions stay on S2
- **NOISE-01** (should-fix) Everything visible serves the step — step 7: the domain page: sidebar, Analytics and Settings buttons, the SPF and DKIM steps, the level panel, the email health report sit around the one action
- **WORD-04** (should-fix) One name for one thing — step 8: the DMARC step says "Step 4 of 4: DMARC" and "1 of 4 steps complete" and offers "Skip setup": a counter the first run does not use

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 7 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 5 |  |
| `words_to_value` | — | 381 |  |
| `reading_time_to_value_s` | — | 96 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1606 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 11988 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After the record was in DNS the dashboard card flipped in 3253 ms when opened; it was not left open while the cache aged (not measured)

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
