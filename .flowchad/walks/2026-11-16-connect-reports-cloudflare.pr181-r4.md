# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report: the live DMARC record lists the shared report address and the domain is connected (the status API says waiting)
- **Walked:** 2026-11-16T23:58:17.949Z
- **Target:** http://127.0.0.1:8863 (local-copy)
- **Commit:** 7118757d6fb6151f1c7b39dd15a8338aa476fa8f
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **ERR-02** (should-fix) Errors say what happened and how to fix it — step 3: dead-end pass: when Cloudflare answers 500 to the write the page says "Could not write the record" and "Internal error" and keeps Apply and Check again, but gives no cause or next move beyond pressing Apply again

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 2 |  |
| `decisions_to_value` | — | 2 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 688 |  |
| `reading_time_to_value_s` | — | 173 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 966 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 5132 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The Do this next card under the panel asks about a DKIM selector while the person is connecting reports (not walked: it is another job)

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
