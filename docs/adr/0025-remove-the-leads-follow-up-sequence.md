---
status: accepted
date: 2026-11-16
decided-by: owner
---
# Remove the leads follow-up sequence

The five follow-up emails sent to people who ran the free email check (days 1, 3, 6, 10 and 14; the engine and the copy lived in `src/funnel/`) are deleted, not kept off and not made opt-in. Owner decision, 2026-11-16, resolving the open decision "the free-check onboarding sequence (delete, keep off, or make it opt-in)": "Yes remove old tips if not useful."

**Context**
- The sequence sold "Fix it" as a path to reject, which contradicts [ADR 0013](0013-fix-one-domain-is-c1-without-reject.md) (the $149 offer ends at monitoring with reports).
- It needed Resend, which the hosted service does not have.
- It ran on the `0 8 * * *` job, which the hosted operator holds.
- Hosted account holders get the lifecycle emails of `src/lifecycle/email/` instead.

**Consequences**
- A free check sends the report and nothing else: no lead is written and the reply carries no follow-up notice. The free-check reply, its fallback delivery and its Reply-To are unchanged.
- Gone: the sequence switch and the service-prices setting, the Leads page and `GET /api/leads`, `POST /api/leads/:id/stop`, the setup-check lines about the sequence, the sequence engine, its copy and the enrolment code. A self-host that had turned the sequence on stops sending those emails after upgrading; no data is deleted by the upgrade.
- Kept, each still used: the `leads` table and its 12-month retention in the `0 8 * * *` job (rows written before this change are still personal data and are still deleted on schedule, or at once on unsubscribe); the suppression list and `/api/unsubscribe` (change alerts, lifecycle summary and tips, the free-check fallback); the monitor opt-in confirmation (`/api/monitor/confirm`); `MAIL_FROM`, `RESEND_API_KEY` and `BOOKING_URL` (the confirmation, the free-check report, the dashboard's "Talk to Max").
- No table or column is dropped. Columns of `leads` that nothing writes any more (`step`, `next_send_at`, `status`, `check_level`, `check_summary`) stay until a later migration chooses to drop them.
- The sequence's copy file no longer appears in the "Fix-offer scope promising reject" row of `docs/single-sources.md`; `OFFER_SCOPE` in `src/billing/offer.ts` is the one place left to align with ADR 0013.
