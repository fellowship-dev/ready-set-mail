# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T23:17:19.268Z
- **Target:** https://127.0.0.1:8866 (local-copy)
- **Commit:** 2ef1aafb3feb8c4601aaec831ff16806f3b3208b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 7: the consent page asks which domains and which of six actions, plus an optional new domain and workspace: decisions = 2; step 7: decisions = 2, needs decisions <= 1
- **PATH-03** (should-fix) Every step earns its place — step 6: after sign-in the person lands on the dashboard, not on the consent they came for: the authorize page says "come back to this tab and reload it", so one screen and one tab switch carry no step of the authorization

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1050 |  |
| `reading_time_to_value_s` | — | 265 |  |
| `non_task_elements_to_value` | — | 12 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 2531 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 11887 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A double click on Allow access sent two consent POSTs (the second landed on the same consent page); whether two grants were written was not checked
- Pasting the emailed code could not be tested with a synthetic paste event; not recorded

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
