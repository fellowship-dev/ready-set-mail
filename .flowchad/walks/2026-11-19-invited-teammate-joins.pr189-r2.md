# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-19T21:06:46.249Z
- **Target:** http://127.0.0.1:8941 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: the invite form asks the email and the role (member or admin), two answers on one screen; step 1: decisions = 2, needs decisions <= 1
- **FOLD-02** (should-fix) Secondary content sits beside or below — step 5 @375: the "Reports are not available" panel sits above the only domain row, so at 375 the verdict row starts below the first screen
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: besides what the step needs: Export PDF; Add domain (disabled); the reports panel that repeats the headline

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 426 |  |
| `reading_time_to_value_s` | — | 107 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 8 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1297 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10874 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The row says "Next: nothing to do." while the same row says SPF and DMARC are not published; for a read-only member nobody-acts-next is the product's choice when reports are not connected (local copy has no report intake), but a person can read it as "all is well".
- At 1440 the role selector shows its chosen label cut off ("Member (read-...").
- Refreshing the code screen returns to the join form, and the password is typed again (the invite stays valid).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
