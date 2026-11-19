---
status: accepted
date: 2026-11-15
decided-by: recorded by the coordinator as an owner decision; no owner quote found
---
# A domain's own DNS records change only when a person asks

Connecting Cloudflare, importing zones, adding a domain and reading a plan never change the records of the domain itself. The product shows the planned records and writes them when an owner or admin presses the button for that record; agents never write DNS (the MCP tools have no DNS write). The only automatic changes are listed below, and each touches a record outside the domain's own records or a record a person turned on earlier.

**Consequences**
- Every record write through `CfClient` in `src/tenancy/cf-client.ts` passes `assertDnsWriteAllowed` in `src/dns/write-policy.ts`. Members cannot reach any of these routes (the read-only gate in `src/api/router.ts`); delegated API keys are refused on every domain write (`src/access/http-policy.ts`).
- Written or deleted when a person presses a button (owner or admin):
  - onboarding Apply, `POST /api/onboarding/dns-apply` in `src/onboarding/routes.ts` (re-reads the plan and refuses a changed one; on the hosted service its DMARC write that carries our report address goes through `applyReportRecord`, ADR 0020);
  - Connect reports' Apply, `POST /api/domains/:id/report-address/apply` (`src/hosted/report-address-routes.ts`): the one write of our report address into a record, from the live record and the person's choice, refused when the record changed since the review (ADR 0020). No other route puts the hosted report address in a record;
  - the domain page: `POST /api/domains/:id/apply-dmarc` (a policy record the person chose; on the hosted service it never adds our address nor drops a published one; also writes the report-authorization record, `provisionDomain` in `src/dns/provision.ts`), `PATCH /api/domains/:id/dmarc` (never adds our address), `POST /api/domains/:id/apply-spf`, SPF flattening on and off (`POST` and `DELETE /api/domains/:id/spf-flatten`), and MTA-STS on, change and off (`/api/domains/:id/mta-sts`), all in `src/api/router.ts`;
  - removing a domain, `DELETE /api/domains/:id`: deletes its hosted records and its report-authorization record (`removeHostedRecords` and `removeAuthRecord` in `src/domains/remove.ts`);
  - self-host only: `POST /api/setup/email-routing` (`ensureEmailRouting` in `src/setup/email-routing.ts`) and `POST /api/setup/custom-domain`, which also call Cloudflare endpoints that create records on Cloudflare's side without passing the write policy.
- Written as a side effect, without a button for that record:
  - a bulk add, `POST /api/domains/bulk-import` (`src/domains/bulk.ts`), writes each new domain's report-authorization record `<domain>._report._dmarc.<reports domain>` on the reports domain (self-host; the hosted service has no reports domain);
  - taking a domain from another workspace (a stronger proof in this workspace) deletes that workspace's hosted and report-authorization records for it (`src/domains/ownership.ts`);
  - the daily crons in `src/cron.ts` rewrite records a person turned on: the flattened SPF record (11:00 UTC, re-resolved from the stored original, never over an edit made outside the app: ADR 0027) and the MTA-STS policy id when the MX hosts change (08:00 UTC). The hosted cron writes only the operator's hosted-records zone (`src/hosted/cron.ts`); the MTA-STS refresh and the operator's custom hostnames and Worker routes are proposed in [ADR 0026](0026-mta-sts-customer-zone-records-and-saas-policy-host.md).
- `docs/coding-agents.md` tells agents to show records and ask before any DNS change. A new automatic write needs a new ADR.
