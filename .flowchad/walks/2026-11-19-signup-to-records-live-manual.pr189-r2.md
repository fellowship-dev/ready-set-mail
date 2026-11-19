# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:21:41.189Z
- **Target:** http://127.0.0.1:8922 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: S2 asks name and organization and whose email: decisions = 2, plus two optional questions; step 3: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 3: the optional role and "where did you hear about us" questions stay on S2
- **NOISE-01** (should-fix) Everything visible serves the step — step 7: the domain page shows Analytics and Settings buttons, SPF and DKIM items, Where it stands, DNS records and Email health report around the one action
- **PATH-06** (should-fix) No loops on the happy path — step 10: the Reports step repeats the status, record and Check again that the DMARC step showed after Connect reports
- **WORD-04** (should-fix) One name for one thing — step 12: "Go to dashboard" lands on the domain page, not on the dashboard (Domains) that holds the first-day card; the DMARC step counts "Step 4 of 4" and "Skip setup"

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 5 |  |
| `words_to_value` | — | 353 |  |
| `reading_time_to_value_s` | — | 89 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 3 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1833 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 14013 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- "Go to dashboard" on the last step of the setup lands on the domain page (#/w/:ws/domains/1), not on the dashboard that holds the first-day card; the person has to open Domains to see the card
- "Go to dashboard" at the end of the wizard opens the domain page; the first-day card is on Domains, one more click away.
- Hosted sign-up: the browser's request to the Turnstile host was aborted by the walk guard (ERR_ABORTED); sign-up still passed on the always-pass test keys.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
