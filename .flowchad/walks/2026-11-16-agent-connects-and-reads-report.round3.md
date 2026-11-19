# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T21:14:51.162Z
- **Target:** https://127.0.0.1:8861 (local-copy)
- **Commit:** c2db0b2
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 8: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 2 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 924 |  |
| `reading_time_to_value_s` | — | 233 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1809 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6515 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
