# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T12:27:18+00:00
- **Target:** https://127.0.0.1:8851 (local-copy)
- **Commit:** 396237c998dc1862dd7edd7cfe39b593f08c006c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 7: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 783 |  |
| `reading_time_to_value_s` | — | 197 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 2883 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10319 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- get_email_report on this local hosted instance says intake is "unavailable / not_configured" while the same report carries the received aggregate data (42 messages, 71.4 percent); the reports-domain setting that field reads is not set here. Not changed by this commit.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
