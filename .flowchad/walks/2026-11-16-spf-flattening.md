# Walk record: spf-flattening

- **Flow:** Owner of a domain with too many SPF lookups turns on flattening and it stays correct
- **Value moment:** Flattening is on - the record lists the sender addresses directly, within 10 lookups and 450 bytes, and the daily check keeps it current or says why it could not
- **Walked:** 2026-11-16T17:26:47.243+00:00
- **Target:** https://127.0.0.1:8851 (local-copy)
- **Commit:** b6a557a40cc84f69e5f434eb96fa543d0107730d
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
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 1 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 757 |  |
| `reading_time_to_value_s` | — | 191 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1793 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7648 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Off the path to value (after the value step), these screens have their primary element below the fold: step 6 (domain page: card on, last changed, Before and Now) {"375":1.62,"1440":0.73}; step 7 (domain page: card needs attention, Try again) {"375":1.63,"1440":0.73}; step 8 (domain page: card on again after Try again) {"375":1.67,"1440":0.78}; step 9 (domain page: turn off confirmation) {"375":1.67,"1440":0.78}; step 11 (within limits: domain page card) {"375":1.42,"1440":0.62}; step 12 (within limits: analyse) {"375":0.04,"1440":0}; step 13 (hosted, HOSTED_SPF_FLATTENING unset: domain page) {"375":0.97,"1440":0.27}. They are the domain page's DNS tools card (a disclosure far down the page) and the within-limits analyse screen at 375 (0.04). Known rough edge: the card is reached from "Do this next" while something needs doing, and from the DNS tools section afterwards.
- The fake DNS answers TXT only; real Cloudflare stores a TXT longer than 255 characters as several strings (not verified here; the result stays within 450 bytes).
- The hosted sign-up and the first-run screens are the walks of other flows; here they are only the way to a workspace.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
