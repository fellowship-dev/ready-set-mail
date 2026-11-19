# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report - the live DMARC record lists the shared report address and the domain is connected (GET /api/domains/:id/report-address says waiting); only for a workspace HOSTED_CONNECT_REPORTS admits
- **Walked:** 2026-11-19T21:26:49.418+00:00
- **Target:** http://127.0.0.1:8933 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **ERR-02** (should-fix) Errors say what happened and how to fix it — step 3: dead-end pass: when Cloudflare answers 500 to the write the page says "Could not write the record" and "Internal error" and keeps Apply, but gives no cause or next move beyond pressing Apply again
- **NOISE-01** (should-fix) Everything visible serves the step — step 1: the domain page: p=reject badge, Analytics and Settings buttons, the "More" disclosure, the DKIM step and a second "Connect reports" step card sit around the one action; step 3: a red "Disconnect reports" button, the line "Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do." and "Only reports from known reporters are counted." show on the screen that only needs to say the address is published

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 3 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 688 |  |
| `reading_time_to_value_s` | — | 173 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 16 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 953 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4798 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The dashboard logs a 404 console error on every domain page when billing is off: GET /api/billing is expected to answer 404 and the code handles it, but the browser still reports a failed request (web/src/lib/billing.ts:108)
- The result screen shows a red Disconnect reports button and a notice about counting reports next to the confirmation that the address is published

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
