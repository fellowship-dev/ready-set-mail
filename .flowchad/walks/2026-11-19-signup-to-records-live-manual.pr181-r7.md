# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:49:25.399Z
- **Target:** http://127.0.0.1:8874 (local-copy)
- **Commit:** e20591f6efbec22737ea38b18f69dd9bf42d1076
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1; step 2: decisions = 5, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 9 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 5 |  |
| `words_to_value` | — | 381 |  |
| `reading_time_to_value_s` | — | 96 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1808 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 15681 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Step 9 at 375x812: the record to publish (the text that carries the shared report address) ends 1.37 screens down; the status and its Check again button, which the person presses next, are in the first screen. Walked as an observation: the flow does not promise the record in the first screen of this step.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
