---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Billing: one Stripe customer and card per workspace, Stripe-hosted pages only, Stripe decides paid

Each workspace has one Stripe Customer and one saved card, so an agency's client can own a workspace and pay directly. Card entry happens only on Stripe-hosted pages (Checkout in setup mode, the billing portal, the hosted invoice for 3-D Secure); purchase is one click in our UI. An order is marked paid only when Stripe, asked again, says its invoice is paid; never on our own click. Owner, 2026-11-15: "One credit card per workspace"; "adding the billing details to the account, permanently ... Then purchase happens by clicking a button on our UI".

**Consequences**
- Only `src/billing/` talks to Stripe (`src/billing/stripe-client.ts`); `test/agent-memory/single-sources.test.ts` guards the host, the SDKs, the client and its constants.
- The one transition to paid is `applyInvoice` in `src/billing/sync.ts`, which re-reads the invoice. It is reached from the webhook (`src/billing/webhook.ts`: `invoice.paid`, and `invoice.payment_action_required` or `invoice.payment_failed` when the invoice turns out paid), from `failOrder` when an invoice it would fail is paid, and from the daily reconcile (`runBillingJob` in `src/billing/reconcile.ts`, hosted cron 11:00 UTC, orders pending over an hour). Order states live in `src/billing/orders.ts`. Details: `docs/billing.md`.
