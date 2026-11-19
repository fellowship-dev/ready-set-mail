# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T16:17:28.576Z
- **Target:** http://127.0.0.1:8853 (local-copy)
- **Commit:** c1069a7e
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: the Members screen asks the owner for an email and a role (2 decisions); the role is prefilled with Member and was left alone; step 1: decisions = 2, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: Export PDF, the Read-only access banner and a long "Reports are not available" block (70 words) sit above the first domain row for a read-only teammate; the same as in the earlier pr177b walk of this flow
- **NOISE-03** (should-fix) Words fit the action — step 5: 238 words on the overview, 70 of them the reports-not-available block before the first domain row; the same as in the earlier pr177b walk of this flow

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 493 |  |
| `reading_time_to_value_s` | — | 124 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 818 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 9856 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A read-only teammate gets the owner-oriented overview: a Reports-not-available block and Export PDF before the first domain; the same as in the earlier pr177b walk of this flow.
- Console errors from the signed-out session probe (GET /api/me answers 401) on the invite page and the first Members load; not visible to the person.
- The final step has no Continue click: the sixth digit submits, so the flow file step "click Continue" is a typed code here (2 clicks, 3 typed fields in all).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
