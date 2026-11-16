---
status: accepted
date: 2026-11-16
decided-by: coordinator (implementation of ADR 0014)
---
# One module decides what a workspace holds and may add; the server alone writes the subscription quantity

Everything about units, the allowance, who may add a domain and the lease every plan change runs under lives in `src/hosted/plan.ts`; the SQL of the domain insert enforces the room itself (`packages/db/src/queries/plan-limit.ts`), so no path can add a billable unit by skipping a check. A paid domain exists only through the owner's confirmed add in a browser session (`POST /api/billing/domains`), which holds the workspace's lease, recomputes the quantity from the database and sends it to Stripe with an idempotency key that names workspace, item, target and the lease's revision. If the Stripe update fails, the domain just added is removed again: it is never free. Removing a domain never waits for Stripe: the row goes first and a failed update marks the plan dirty for the daily job (over-billing by at most one proration until then).

**Consequences**
- API keys, agent credentials and members cannot start a paid domain; they get a plain `402 plan_required`.
- A webhook event changes a workspace's plan only after the subscription is re-read from Stripe and its customer, `workspace_id` metadata and price are all ours; anything else is ignored and logged.
- Stripe is told nothing when `HOSTED_PLAN` is off (no create, quantity change or cancel); the webhook still records subscription events and the daily job only reads.
