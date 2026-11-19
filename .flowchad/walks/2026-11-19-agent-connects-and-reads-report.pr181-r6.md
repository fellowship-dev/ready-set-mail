# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-19T21:04:55.153Z
- **Target:** https://127.0.0.1:8971 (local-copy)
- **Commit:** 25ce01b5181d11f18342497a02c06ecdae25032a
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 6: the consent page asks which domains and which actions, plus an optional new domain with workspace, in one screen: decisions = 2; step 6: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 2 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 534 |  |
| `reading_time_to_value_s` | — | 135 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 2270 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6484 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
