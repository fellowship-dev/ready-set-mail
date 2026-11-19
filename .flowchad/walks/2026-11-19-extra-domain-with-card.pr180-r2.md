# Walk record: extra-domain-with-card

- **Flow:** Hosted owner with one proven domain adds a second with a card and is billed once it is proven
- **Value moment:** Settings → Billing says "Billed now: 1 extra domain." after the second domain is proven (the fake shows one subscription, quantity 1, yearly price)
- **Walked:** 2026-11-19T21:30:30.664+00:00
- **Target:** http://127.0.0.1:8942 (local-copy)
- **Commit:** ebc21c7879073932f31cbe0fe7b75b131e2a172b
- **Kind:** screens, baseline
- **Gate:** FAIL
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Not ready: do not hand this to a human tester until these pass.

- blocker FOLD-01 failed: The first input is visible without scrolling

### Blockers failed

- **FOLD-01** The first input is visible without scrolling — step 3 @375: scroll_before_primary_vh = 1.63, needs scroll_before_primary_vh = 0; step 3 @1440: scroll_before_primary_vh = 1.09, needs scroll_before_primary_vh = 0; step 4 @375: scroll_before_primary_vh = 1.67, needs scroll_before_primary_vh = 0; step 4 @1440: scroll_before_primary_vh = 1.09, needs scroll_before_primary_vh = 0; step 7 @375: scroll_before_primary_vh = 1.65, needs scroll_before_primary_vh = 0; step 7 @1440: scroll_before_primary_vh = 1.06, needs scroll_before_primary_vh = 0

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 2 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 767 |  |
| `reading_time_to_value_s` | — | 193 |  |
| `max_scroll_before_primary_vh` | — | 375: 1.67 · 1440: 1.09 |  |
| `non_task_elements_to_value` | — | 3 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 3443 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 27234 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Settings → Billing read "Billed now: 0 extra domains" for 30 s after the second domain was proven when it had been opened less than 15 s before (cached billing view, staleTime 15 s); a reload showed 1. A person publishing a DNS record takes longer, so the walk waited 16 s; noted, not judged by a rule.
- The fake Checkout is one link, so the real Stripe card form (field count) is not measured.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
