# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T06:10:37.988+00:00
- **Target:** http://127.0.0.1:8891 (local-copy)
- **Commit:** 7e55dc1433fd8ebb9e0e0ec5b96037bd9c7e93ad
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **NAV-03** (should-fix) Nothing offered that cannot work — step 5: a member is offered Members, Audit log and a disabled Add domain; opening Members says Only owners and admins can see the members
- **NOISE-01** (should-fix) Everything visible serves the step — step 2: after the link appears, a Pending invites list repeats the same invite directly below it; step 5 @375: the member lands on a Read-only access banner and a long Reports are not available panel before the first domain row; the row starts at 762 of 812 px

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 469 |  |
| `reading_time_to_value_s` | — | 118 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 796 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 5558 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- At 375 wide a list row's identifying text is squeezed to a single character by the badge and the date beside it, so the person cannot tell who the row is for (the owner's row on the members page).
- At 375 wide the result the owner's step exists for, the link to pass on, starts at the bottom edge of the first screen (about 795 of 812 px) after the click, so it is cut off until the owner scrolls.
- The same address appears twice in one list row (as name and as email) when a person has no name.
- A signed-out visit to the invite link logs a 401 console error from the session check before the form renders; harmless but it is the first thing in the console of the first screen.
- The wrong-code screen clears the field after the error; the person retypes all six digits (fine for a code, listed for completeness).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
