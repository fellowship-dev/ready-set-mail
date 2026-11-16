# Ready Set Mail

Ready Set Mail gets a domain's email authentication (SPF, DKIM, DMARC) from "I don't know" to enforced without breaking mail: it checks public DNS, receives DMARC reports, writes records through Cloudflare when asked, and sells the fix as a service. One codebase runs as the hosted service and as a self-hosted install.

Each term: what it is, the words to avoid, and its home in the code (`Home`). **Two meanings** marks a word the code or the UI uses for two things today; say which one you mean.

## People and places

**Workspace**:
The container for domains, reports, members and Cloudflare connections; everything a request reads is scoped to one. Self-host has the implicit default workspace `ws_default`.
_Avoid_: account, tenant (in UI copy), project
Home: `workspaces` in `packages/db/src/schema.ts`; per-request context `src/tenancy/context.ts`; guide `docs/workspaces.md`.

**Member** and **role**:
A user's membership in one workspace, with the role `owner`, `admin` or `member` (read-only). Roles are per workspace.
_Avoid_: team member, seat, viewer
Home: `MembershipRole` in `packages/db/src/schema.ts`. Role checks are written inline in about two dozen files: there is no single policy module yet.

**Organization** — **two meanings** (three with PR #177):
(1) the *organizational domain* of DMARC, the registrable name a subdomain belongs to (`organizationalDomain` in `packages/dns-checks/src/org-domain.ts`); (2) a report sender's *organisation* (the DKIM organisation in the known-reporters registry, `src/dmarc/known-reporters.ts`). PR #177 adds (3) the customer's company name asked at sign-up. Say "registrable domain", "reporter" or "company".

**Instance mode**:
`MODE=saas` is the hosted service (with `SAAS_ENABLED=1`); `selfhost` (the default) is someone's own install on their Cloudflare account.
_Avoid_: cloud, SaaS (in UI copy: "hosted")
Home: `getMode` in `src/tenancy/mode.ts`; `docs/hosted.md`, `docs/self-hosting.md`.

## Domains and proof

**Domain**:
A hostname a workspace monitors. It exists only once ownership is proven (or, self-host, added by the owner); a name not yet proven is a claim.
Home: `domains` in `packages/db/src/schema.ts`; adding one: `enrollDomain` in `src/domains/service.ts`.

**Claim**:
A workspace's pending request for a domain it has not proven yet, waiting for its proof.
_Avoid_: pending domain, unverified domain
Home: `domainClaims` in `packages/db/src/schema.ts`; `src/domains/ownership.ts`.

**Ownership proof**:
Why a workspace may hold a domain: the TXT record `_readysetmail.<domain>` = `readysetmail-verify=<token>`, an active zone of a connected Cloudflare account (ADR 0002), or a proven parent domain.
_Avoid_: verification (alone), validation
Home: `src/domains/ownership.ts` only (`cloudflareProof`, `provenByTxt`, `verifyClaim`). The rule is restated in other files today: see `docs/single-sources.md`.

**Connection** and **zone**:
A connection is the workspace's link to one Cloudflare account (OAuth or a pasted token), with an allow-list of zones; a zone is Cloudflare's container for one domain's DNS. A workspace may hold several connections (ADR 0005).
_Avoid_: integration, Cloudflare account (for the link itself)
Home: `src/connections/`; the import is `importZones` in `src/connections/import.ts`; all Cloudflare calls go through `CfClient` in `src/tenancy/cf-client.ts`.

**Apply**:
The explicit step that writes planned DNS records through a connection (ADR 0004). Nothing else writes a customer's DNS.
Home: `src/onboarding/routes.ts` (`/api/onboarding/dns-apply`); write rules `src/dns/write-policy.ts`.

## Judging a domain

**Check** — **two meanings**:
(1) a **DNS check**: reading a domain's SPF, DKIM, DMARC, MTA-STS and MX from public DNS (`checkDomain` in `packages/dns-checks/src/report.ts`; the Worker's adapter has a different function with the same name in `src/email/dns-check.ts`); (2) a **real-email check** ("free check"): someone sends a message to a check address and gets the result by reply (`src/email/free-check.ts`, hosted `src/hosted/canary.ts`). Say "DNS check" or "email check".

**Level**:
A domain's rung on the authentication ladder. **Two ladders today** (three counting the email check's protected / at risk / exposed): the dashboard's three rungs, Delivering / Authenticated / Protected (`assessDomain` in `web/src/lib/levels.ts`, names in `packages/ui/src/components/level-ladder.tsx`), and the agent report's four, Unprotected / Monitoring / Enforced / Hardened (`packages/dns-checks/src/report.ts`). Canonical: **pending owner decision** (coordinator's recorded pick: the dashboard's three; `docs/adr/OPEN.md`).
_Avoid_: grade, score

**Verdict**:
The one-line judgement of a domain shown to a person (verified, needs attention, unknown…) with its reason.
Home: `domainVerdict` in `web/src/lib/verdict.ts`; words in `STATUS` in `packages/ui/src/components/status.tsx`.

**Standing**:
Where a domain stands overall: the verdict plus freshness, hosted state, parent, report window and uncounted reports. Not one module yet; today `web/src/lib/verdict.ts` is the closest and other rules remain (`docs/single-sources.md`).
_Avoid_: health, status (alone)

**Next step**:
The one action the person should take next for a domain. Several producers today (DMARC steps, dashboard actions, the agent report); see `docs/single-sources.md`.
_Avoid_: recommendation, guidance, to-do

## Reports

**Report** (aggregate):
A DMARC aggregate (RUA) report a mailbox provider sends about one domain for one day; TLS-RPT reports are separate.
_Avoid_: digest (that is our weekly email), PDF (that is the export)
Home: parsing `src/dmarc/`, storing `packages/db`.

**Report address** — **two forms**:
Where a domain's DMARC record sends reports. **Hosted:** one shared address for every customer, `rua@<INTAKE_DOMAIN>`, routed by the domain inside the report (ADR 0006; `fixedReportAddress` in `src/hosted/fixed-address.ts`). Hosted records still use token addresses `rua+<token>@<INTAKE_DOMAIN>` (`intakeAddress` in `src/hosted/tokens.ts`). **Self-host:** `rua@<reports domain>`, the workspace's own reports domain.
_Avoid_: RUA email, inbox

**Intake**:
Receiving report mail: authenticating the sender, attributing the report to a workspace, applying caps, storing.
Home: hosted `src/hosted/intake.ts`; self-host and shared parts `src/email/handler.ts`, `src/dmarc/reporter-auth.ts`.

**Counting mode**:
Which received reports count toward a domain's numbers: `registry` (known reporters, hosted default), `authenticated`, or `all` (self-host default).
Home: `reportCounting` in `src/dmarc/counting.ts`; the type `CountingMode` in `packages/db/src/queries/counting.ts`.

## Selling and agents

**Offer** and **order**:
The offer is the priced service, today one: "Fix one domain" ($149, ADR 0013). An order is one purchase of it by a workspace, paid only when Stripe's webhook says so (ADR 0007).
_Avoid_: plan, subscription, package
Home: `src/billing/offer.ts`, order states `src/billing/orders.ts`; `docs/billing.md`.

**Agent**:
An AI client acting for a person through the MCP server or the API, with finite grants the person consented to. The MCP tools never change DNS or send mail.
_Avoid_: bot, integration
Home: `src/mcp/`, grants `src/access/`; `docs/agent-operations.md`.
