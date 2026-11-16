# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered: the invoice is paid (invoice.paid webhook)
- **Walked:** 2026-11-16T17:06:02.243Z
- **Target:** http://127.0.0.1:8853 (local-copy)
- **Commit:** 2afc3d378b1be092d59735a7d241cbe2f11426cc
- **Kind:** screens
- **Gate:** PASS-WITH-OVERRIDES
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready only with overrides: blocker rules failed and were overridden. Tell the tester about every override below first, and fix them next.

### Known rough edges (1)

- **FOLD-01** (blocker, **OVERRIDDEN** by Claude (Fable 5.2) for Max F. Findel, the MTA-STS hosted PR; reviewer to accept on 2026-11-16) The first input is visible without scrolling — failed: step 1 @375: the offer button 'Have us fix this domain' is 0.63 viewport heights below the first screen at 375 (0 at 1440): it is a quiet card under the 'Do this next' list, as built before this branch; step 1 @375: scroll_before_primary_vh = 0.63, needs scroll_before_primary_vh = 0; accepted because: the offer is deliberately a quiet card below the list of what to do next; this branch only adds a DNS tools section further down the page, so the position of the offer is unchanged from main and moving it is a product decision for the owner

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 1 |  |
| `decisions_to_value` | — | 2 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 1424 |  |
| `reading_time_to_value_s` | — | 359 |  |
| `max_scroll_before_primary_vh` | — | 375: 0.63 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6148 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The 3-D Secure variant (Stripe's hosted invoice page) and a lost webhook (the daily reconcile) are not walked; the fake Stripe pays at once.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (MTA-STS on the hosted service)

- Why this record: `web/src/pages/domains/DomainDetailPage.tsx` is on this flow's `covers:` list and this branch changes it (the DNS tools section, which holds the MTA-STS card, is now always shown, on hosted too). A same-day not-affected record for this flow is already in the base and the checker allows one per flow and day, so the record is a walk. The change is below the offer and the order steps: the walk shows the offer, confirm, card and paid steps as before.
- How it was run: `node /workspace/notes/walk/buy.mjs` starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, hosted, MODE=saas, over plain http on 127.0.0.1:8853) from the dashboard built from this branch's HEAD, with the repo's fake Stripe (`e2e/support/fake-stripe.mjs`) through the test-only `STRIPE_API_BASE`; the fake sends the signed `invoice.paid` webhook to the Worker. The browser answers the domain page's two DNS reads as `e2e/billing.spec.ts` does, so the made-up domain has something to fix and the offer appears. The gate was `node .agents/skills/flow-gate/scripts/gate.mjs <results.json> --target http://127.0.0.1:8853 --record .flowchad/walks`, PASS-WITH-OVERRIDES (exit 3).
- The one override (FOLD-01, step 1 at 375 px) is a position the branch did not change: the offer is a quiet card under "Do this next", 0.63 viewport heights below the first screen at 375 and fully visible at 1440. The reviewer is asked to accept it or to decide that the offer moves.
- Screenshots of every step at 375 and 1440 are in `/workspace/notes/shots/` (out of the repository).
