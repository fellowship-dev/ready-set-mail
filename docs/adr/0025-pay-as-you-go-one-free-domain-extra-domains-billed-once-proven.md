---
status: accepted
date: 2026-11-19
decided-by: Max
---
# Pay as you go: one free domain per workspace, extra domains billed once proven

On the hosted service, when the operator turns the plan on (`HOSTED_PLAN=pay_as_you_go`, with Stripe configured), a workspace holds one domain for free. Every extra domain needs a card on file and is billed per domain, yearly ($50) or monthly ($5), the owner's choice before the first extra domain is billed. Decisions D-44, D-45, D-46, D-51 and D-60, and the owner's rules of 2026-11-19:

1. A domain added but not yet proven still uses a place. The one room rule (`domainRoom` in `src/hosted/plan-limits.ts`) already counts waiting claims; the plan adds no second counting rule.
2. Extra domains need a card on file, then are pay as you go: without a card the second name is refused (HTTP 402, `card_required`).
3. A domain is charged only when it is proven and active: a live row, not evicted, proof not lost (`provenDomainIds` in `src/domains/ownership.ts`, the rule behind `isDomainProven`). A claim is never billed.
4. The yearly price is shown in the app, read from Stripe by lookup key (`rsm_extra_domain_yearly`, `rsm_extra_domain_monthly`).
5. A per-domain add-on hook exists (`PLAN_ADD_ONS` in `src/billing/plan.ts`): a feature such as SPF flattening can attach a price to one domain later. Its price is open, so nothing is charged for it now.
6. Billing is off by default: with the Stripe settings unset or `HOSTED_PLAN` unset the billing routes answer 404, nothing in the app mentions paying, and a workspace is limited exactly as before (`MAX_DOMAINS_PER_WORKSPACE`). Self-host has no billing and no caps.

**Consequences**
- One cap: `domainCap` (`src/domains/ownership.ts`, re-exported from `src/domains/service.ts`) is async. Self-host: none. Plan off: `MAX_DOMAINS_PER_WORKSPACE`. Plan on: the free place while one is open, else the free place unless the workspace's Stripe customer has a default card, then `MAX_DOMAINS_PER_WORKSPACE`. Stripe is asked only when the free place is already used. The atomic inserts keep `slotsUsed < max` with that number.
- One subscription per workspace with one item, quantity = proven live domains minus the free one, never below 0 (`syncPlan` in `src/billing/plan.ts`). It is created when the quantity first goes above 0 and never deleted automatically. A Stripe failure never blocks or undoes adding or removing a domain: it is stored as `sync_error` and the daily billing job syncs every workspace that has a row again. Table `workspace_plans`, migration `0026_hosted_plan.sql` (additive).
- Subscription invoices carry no order: the webhook answers them 200 and changes nothing (`unknown_order`). No new webhook event types.
- Stripe HTTP stays in `src/billing/stripe-client.ts`.
- Numbered 0025: 0023 and 0024 are on main, and 0015 to 0019 and 0021 are reserved by other open pull requests. The first design of this plan (pull request 180, 8,400 lines) is superseded by this one.
