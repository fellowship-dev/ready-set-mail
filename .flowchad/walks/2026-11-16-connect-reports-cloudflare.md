# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report - the live DMARC record lists the shared report address and the domain is connected
- **Walked:** 2026-11-16T04:35:27.030Z
- **Target:** http://127.0.0.1:8861 (local-copy)
- **Commit:** 28b610c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: above the single action sit the policy badge, an Analytics tab and a Settings tab that the step does not need

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 1 |  |
| `decisions_to_value` | — | 2 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 767 |  |
| `reading_time_to_value_s` | — | 193 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 10 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1547 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 3782 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The state the person just reached moves on a reload: right after Apply the status panel is the first thing on the page; after a reload the same status sits below the next-steps list and the overview (about 790 px down at 1440x900), so the page no longer opens on what was just achieved.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
