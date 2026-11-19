# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `src/billing/config.ts`, `src/billing/plan.ts`, `src/billing/price.ts`, `src/billing/reconcile.ts`, `src/billing/routes.ts`, `src/billing/stripe-client.ts`, `web/src/components/billing/FixOffer.tsx`, `web/src/lib/billing.ts`, `web/src/pages/domains/DomainDetailPage.tsx`, `web/src/pages/settings/BillingSection.tsx`
- **Reason:** The billing code changed here only to add the pay-as-you-go plan (`src/billing/plan.ts`, subscription calls in `stripe-client.ts`, a recurring-price check in `price.ts`, the plan block in `routes.ts` and `BillingSection.tsx`, the daily re-sync in `reconcile.ts`). Every one of them is inert unless the operator sets `HOSTED_PLAN=pay_as_you_go`: with it unset `GET /api/billing` answers `plan: null`, Settings → Billing renders exactly what it did, and the offer, confirm, card, Pay and every word of the one-time purchase are untouched. `DomainDetailPage.tsx`, `FixOffer.tsx` and the other web files in the list come from the merged subdomains-slice1 (#181), which carries its own walk records for them. **No walk was run for this pull request**: this record is a judgement, not a walk, and the reviewer accepts or rejects it.
- **By:** Claude Opus 5.5 (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-19
