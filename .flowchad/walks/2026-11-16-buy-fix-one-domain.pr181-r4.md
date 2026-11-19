# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered: the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-16T23:49:51.675Z
- **Target:** http://127.0.0.1:8864 (local-copy)
- **Commit:** 7118757d6fb6151f1c7b39dd15a8338aa476fa8f
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: the domain page: sidebar, Analytics and Settings buttons, the SPF and DKIM steps, the level panel and two disclosures sit around the one offer

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 2 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 1470 |  |
| `reading_time_to_value_s` | — | 371 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 5 |  |
| `longest_wait_ms` | — | 3221 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10245 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The offer text promises "DMARC moved to reject" although ADR 0013 ends Fix one domain at monitoring with reports: a known, owner-owned open item (docs/single-sources.md, "Fix-offer scope promising reject")
- A member sees the offer and opens the confirm step before reading "Only the workspace owner can add a card or buy."

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
