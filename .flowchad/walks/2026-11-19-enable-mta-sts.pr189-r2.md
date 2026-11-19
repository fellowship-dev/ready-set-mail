# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-19T21:07:31.961Z
- **Target:** http://127.0.0.1:8951 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (0)

- none found by the rules

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 1 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 435 |  |
| `reading_time_to_value_s` | — | 110 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 871 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7074 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- On the page that shows the first report, the report table sits below the Enforce card: at 1440 and at 375 the first screen shows Where it stands and the enforce rule, and the person scrolls to see who sent the report (positions in tls_reports_position).
- The first report a sender sends covers a day that ended before the policy was published, so the rule line says A verified report arrived, but it covers a period before this policy was published. The statement is true and stays Missing until a later report.
- A domain address that does not exist (a missing or another workspace's id) says Could not load MTA-STS, domain not found, with only Try again: it offers no way back to the domain list except Back to domain.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
