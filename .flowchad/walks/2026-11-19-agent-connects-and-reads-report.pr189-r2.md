# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-19T21:13:39.963Z
- **Target:** https://127.0.0.1:8942 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 6: the consent page asks which domains and which of six actions (two decisions), plus an optional new domain; step 6: decisions = 2, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: besides what the step needs: the optional new-domain block and the Access ends selector

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 2 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 842 |  |
| `reading_time_to_value_s` | — | 212 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1254 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7822 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Opening /mcp in a browser shows a blank page (the 401 has no body; the information is in the WWW-Authenticate header).
- The consent page offers an optional new-domain block (workspace select, domain input) that most connections do not need, above the actions the person is deciding on.
- Reusing an authorization code answers 400 invalid_grant "Authorization code already used" and the connection made with it stops working (expected OAuth behaviour, not said anywhere a person sees).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
