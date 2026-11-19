# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-17T00:29:36.297Z
- **Target:** https://127.0.0.1:8873 (local-copy)
- **Commit:** 84d5264982ff2a2aeb4daa2b7df2556472ddff63
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 7: the consent page asks which domains, which of five actions, plus an optional new domain with workspace: decisions = 2; step 7: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 906 |  |
| `reading_time_to_value_s` | — | 228 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 424 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10300 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
