# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered - the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-19T21:19:13.307+00:00
- **Target:** http://127.0.0.1:8931 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: the domain page: the attention banner, Analytics and Settings buttons, the SPF, DMARC and DKIM steps, the level panel, the reports notice, the setup wizard line and two disclosures sit around the one offer; step 3: two identical "Card saved" toasts show over the confirm step; step 4: the two "Card saved" toasts are still on screen over the paid dialog
- **WAIT-03** (should-fix) Outside waits are explained — step 4: "Confirming your payment. This takes a moment and updates by itself." says nothing about what to do if it does not update (the webhook is the only signal; the daily reconcile is not mentioned)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 623 |  |
| `reading_time_to_value_s` | — | 157 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 15 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1653 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7199 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A notification fires twice for one event: "Card saved" and "No card was added" each show two identical toasts after the return from Stripe (web/src/lib/card-return.ts:24-25, called from web/src/components/billing/FixOffer.tsx:23)
- Refreshing the page on the confirm step closes it: the person finds the offer again and starts the confirm step over (the card stays on file)
- The browser Back button from the domain after returning from Stripe lands on Stripe's finished Checkout page, which offers to add a card again
- The offer text promises "DMARC moved to reject" although ADR 0013 ends Fix one domain at monitoring with reports: a known, owner-owned open item (docs/single-sources.md, "Fix-offer scope promising reject")

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
