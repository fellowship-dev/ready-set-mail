# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered - the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-19T20:51:40.733Z
- **Target:** http://127.0.0.1:8961 (local-copy)
- **Commit:** 25ce01b5181d11f18342497a02c06ecdae25032a
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: the domain page: sidebar, Analytics and Settings buttons, the SPF and DKIM steps and the level panel sit around the one offer

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 1470 |  |
| `reading_time_to_value_s` | — | 371 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 10 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 892 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6197 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
