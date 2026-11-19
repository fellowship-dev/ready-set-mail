# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-17T12:30:11.796Z
- **Target:** http://127.0.0.1:8932 (local-copy)
- **Commit:** 7911d9e
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 1: besides what the step needs: the list of people with role selectors, Make owner and Remove; step 2: besides what the step needs: the list of people with role selectors, Make owner and Remove; step 5: besides what the step needs: Export PDF; Add domain (disabled); Connect reports (locked for a member); the read-only notice shown twice

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 540 |  |
| `reading_time_to_value_s` | — | 136 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 901 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7364 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The first domain's row on a read-only member's overview, at 375 px, ends 0.04 viewport heights (about 33 px) below the first screen; the step has no action for a member, so the rule's first-screen measure took another element, and this is the row the person came for.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
