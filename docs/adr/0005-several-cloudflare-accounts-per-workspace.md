---
status: accepted
date: 2026-11-15
decided-by: recorded by the coordinator as an owner decision; no owner quote found
---
# A workspace can hold several Cloudflare connections, shown by account

A workspace links one or more Cloudflare connections (OAuth or a pasted token), each tied to one Cloudflare account; each domain is linked to the connection whose zone proved it. Settings and the import show connections grouped by Cloudflare account.

**Consequences**
- Connections live in `src/connections/` (`service.ts`, `accounts.ts` `accountViews`); `TenantContext.cfFor(domain)` picks the client for a domain. Reconnecting must reach the same account (`409 cf_account_mismatch`); a different account is a new connection (`docs/cloudflare-oauth.md`).
