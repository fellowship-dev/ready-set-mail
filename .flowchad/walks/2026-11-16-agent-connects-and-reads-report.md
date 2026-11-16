# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T07:26:13+00:00
- **Target:** https://127.0.0.1:8851 (local-copy)
- **Commit:** 529fc707b72d6c02fef711ec1648f27a9e144161
- **Kind:** screens
- **Gate:** FAIL
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Not ready: do not hand this to a human tester until these pass.

- blocker FOLD-01 failed: The first input is visible without scrolling

### Blockers failed

- **FOLD-01** The first input is visible without scrolling — step 6 @375: scroll_before_primary_vh = 1.79, needs scroll_before_primary_vh = 0; step 6 @1440: scroll_before_primary_vh = 1.13, needs scroll_before_primary_vh = 0

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 6: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 776 |  |
| `reading_time_to_value_s` | — | 196 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 2168 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13841 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
