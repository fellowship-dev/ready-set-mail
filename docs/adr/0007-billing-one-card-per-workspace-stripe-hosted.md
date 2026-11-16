---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Billing: one Stripe customer and card per workspace, Stripe-hosted pages only, the webhook decides paid

Each workspace has one Stripe Customer and one saved card, so an agency's client can own a workspace and pay directly. Card entry happens only on Stripe-hosted pages (Checkout in setup mode, the billing portal, the hosted invoice for 3-D Secure); purchase is one click in our UI. Only Stripe's `invoice.paid` webhook marks an order paid. Owner, 2026-11-15: "One credit card per workspace"; "adding the billing details to the account, permanently ... Then purchase happens by clicking a button on our UI".

**Consequences**
- Only `src/billing/` talks to Stripe (`stripe-client.ts`); `test/agent-memory/single-sources.test.ts` guards it. Order states live in `src/billing/orders.ts`; the webhook is `src/billing/webhook.ts`. Details: `docs/billing.md`.
