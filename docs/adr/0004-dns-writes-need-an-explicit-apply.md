---
status: accepted
date: 2026-11-15
decided-by: recorded by the coordinator as an owner decision; no owner quote found
---
# DNS writes happen only after an explicit Apply

The product never changes a customer's DNS as a side effect of connecting, importing, adding a domain or reading a plan. It shows the planned records and writes them only when a person presses Apply (or, for an agent, never: the MCP tools do not change DNS).

**Consequences**
- The onboarding writes go through `POST /api/onboarding/dns-apply` in `src/onboarding/routes.ts`, which re-reads the plan and refuses a changed one; every Cloudflare DNS write passes the policy in `src/dns/write-policy.ts` (`CfClient` in `src/tenancy/cf-client.ts` calls `assertDnsWriteAllowed`).
- `docs/coding-agents.md` tells agents to show records and ask before any DNS change.
