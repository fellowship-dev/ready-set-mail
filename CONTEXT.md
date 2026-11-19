# Ready Set Mail

Ready Set Mail gets a domain's email authentication (SPF, DKIM, DMARC) from "I don't know" to enforced without breaking mail: it checks public DNS, receives DMARC reports, writes records through Cloudflare when a person asks, and sells the fix as a service. One codebase runs as the hosted service and as a self-hosted install.

Each term: what it is, the words to avoid, and its home in the code (`Home`). **Two meanings** marks a word the code or the UI uses for two things today; say which one you mean.

## People and places

**Workspace**:
The container for domains, reports, members and Cloudflare connections; everything a request reads is scoped to one. Self-host starts with the implicit workspace `ws_default`.
_Avoid_: account, tenant (in UI copy), project
Home: `workspaces` in `packages/db/src/schema.ts`; per-request context `src/tenancy/context.ts`; guide `docs/workspaces.md`.

**Member** and **role**:
A user's membership in one workspace, with the role `owner`, `admin` or `member`. Roles are per workspace. A member is read-only: the router refuses every request other than GET or HEAD from a session that is not owner or admin (`admin required`, 403), except managing one's own API keys and `/api/spf-lookup-count`. Routes the router hands off before that gate check roles themselves (billing is owner-only; onboarding and connections need owner or admin). A user can belong to no workspace: removing a member, or a member leaving, ends only that membership (their keys and agent approvals for the workspace end with it) and the login, its sessions and its other workspaces stay; with none left the dashboard shows "No workspace yet" (`NoWorkspacePage`), whose Create workspace starts the normal first-run setup (ADR 0024). Only the owner changes a member's role between `admin` and `member` (`POST /api/workspaces/:id/members/:userId/role` in `src/workspaces/routes.ts`; never the owner's row, never one's own). Agents and API keys are decided by `canAccess` in `src/access/policy.ts` (members never get `domains:manage`), and `src/access/http-policy.ts` keeps delegated keys off every domain write.
_Avoid_: team member, seat, viewer
Home: `MembershipRole` in `packages/db/src/schema.ts`; the read-only gate in `src/api/router.ts`; `src/access/policy.ts`.

**Organization** — **two meanings** (three with PR #177):
(1) the *organizational domain* of DMARC, the registrable name a subdomain belongs to (`organizationalDomain` in `packages/dns-checks/src/org-domain.ts`); (2) a report sender's *organisation* (the DKIM organisation in the known-reporters registry, `src/dmarc/known-reporters.ts`). PR #177 adds (3) the customer's company name asked at sign-up. Say "registrable domain", "reporter" or "company".

**Instance mode**:
`MODE=saas` is the hosted service; anything else is `selfhost` (the default), someone's own install on their Cloudflare account. `getMode` reads only `MODE`: ownership proof, claims and the counting default switch on it. The hosted-only features (report intake at `INTAKE_DOMAIN`, hosted records, the hosted cron job, billing's daily job) also need `SAAS_ENABLED=1` (`hostedEnabled` in `src/hosted/config.ts`).
_Avoid_: cloud, SaaS (in UI copy: "hosted")
Home: `getMode` in `src/tenancy/mode.ts`; `docs/hosted.md`, `docs/self-hosting.md`.

## Domains and proof

**Domain**:
A hostname a workspace monitors: a row of `domains`. On the hosted service a row is added only after an ownership proof; self-host admits the owner's own domains without one (`selfhost`). A row can still be **unproven**: `verified_via` is `legacy` for a row from before ownership checks and for a row whose zone proof was withdrawn (`withdrawProof` in `src/domains/proof-recheck.ts`, which also sets `proof_lost_at`), and a row admitted through a parent stops counting when the parent leaves. Report connection, billing and the shared-address intake refuse a `legacy` row until it is proven again (the token-address intake refuses only a row whose proof was withdrawn); onboarding's DNS writes refuse only a row whose parent left (`src/onboarding/domains.ts` lets a `legacy` row through). Whether a row counts as proven: `isDomainProven` in `src/domains/ownership.ts`.
Home: `domains` in `packages/db/src/schema.ts`; adding one: `enrollDomain` in `src/domains/service.ts`.

**Claim**:
A workspace's pending request for a domain it has not proven yet, waiting for its proof. A claim is not a domain row.
_Avoid_: pending domain, unverified domain
Home: `domainClaims` in `packages/db/src/schema.ts`; `src/domains/ownership.ts`.

**Ownership proof**:
Why a workspace may hold a domain: the TXT record `_readysetmail.<domain>` = `readysetmail-verify=<token>` (the old prefix `inboxangel-verify=` is still accepted), an active zone of a connected Cloudflare account (ADR 0002; on the hosted service refused while another workspace holds a parent or child of the name), or a proven parent domain.
_Avoid_: verification (alone), validation
Home: `src/domains/ownership.ts` (`admitDomain`, `cloudflareProof`, `admitByZone`, `provenByTxt`, `verifyClaim`, `isDomainProven`; the kind of proof as a category: `proofMethodOf`, `proofMethodOfVia`, `proofPathOf`). The proof columns are read in other files too: see "Reads and writes of the proof columns" in `docs/single-sources.md`.

**Connection** and **zone**:
A connection is the workspace's link to one Cloudflare account (OAuth or a pasted token), with an allow-list of zones; a zone is Cloudflare's container for one domain's DNS. A workspace may hold several connections (ADR 0005).
_Avoid_: integration, Cloudflare account (for the link itself)
Home: `src/connections/`; the import is `importZones` in `src/connections/import.ts`; every call the Worker makes to the Cloudflare REST API (`api.cloudflare.com`) goes through `CfClient` in `src/tenancy/cf-client.ts` (the OAuth token exchange and Turnstile use other Cloudflare hosts).

**Apply** and the other DNS writes:
The product writes a customer's DNS only through a connection, and every record write through `CfClient` passes `assertDnsWriteAllowed` in `src/dns/write-policy.ts`. ADR 0004 lists every path that writes or deletes records and what triggers it. Most are a person pressing a button (owner or admin): onboarding Apply (`POST /api/onboarding/dns-apply` in `src/onboarding/routes.ts`), Connect reports' Apply (`POST /api/domains/:id/report-address/apply`: the one write of our report address), the domain page's DMARC, SPF, SPF-flattening and MTA-STS actions, and removing a domain. Some are side effects: a bulk add writes each domain's report-authorization record on the reports domain, taking a domain from another workspace removes that workspace's records for it, and two daily crons rewrite records the person turned on (SPF flattening, the MTA-STS policy id).
Home: ADR 0004; write rules `src/dns/write-policy.ts`.

## Judging a domain

**Check** — **two meanings**:
(1) a **DNS check**: reading a domain's SPF, DKIM, DMARC, MTA-STS and MX from public DNS (`checkDomain` in `packages/dns-checks/src/report.ts`; the Worker's adapter has a different function with the same name in `src/email/dns-check.ts`); (2) a **real-email check** ("free check"): someone sends a message to a check address and gets the result by reply (`src/email/free-check.ts`, hosted `src/hosted/canary.ts`). Say "DNS check" or "email check".

**Level**:
A domain's rung on the authentication ladder. **Two ladders today** (three counting the email check's protected / at risk / exposed): the dashboard's three rungs, Delivering / Authenticated / Protected (`assessDomain` in `web/src/lib/levels.ts`, names in `packages/ui/src/components/level-ladder.tsx`), and the agent report's four, Unprotected / Monitoring / Enforced / Hardened (`packages/dns-checks/src/report.ts`). Which one is canonical is an **open owner decision** (`docs/adr/OPEN.md`); do not build on either.
_Avoid_: grade, score

**Subdomain**:
A name under a domain (`app.example.com` under `example.com`), shown inside that domain's page, never as a sibling (ADR 0023, decided; the data model still keeps each added subdomain as its own row, which a later slice changes). Its mail is reported inside its organizational domain's report unless it publishes a DMARC record of its own. The names a domain's reports show are listed on its page: `namesSeen` in `src/domains/names.ts`, `GET /api/domains/:id/names`.
_Avoid_: sibling domain, child domain

**Organizational domain**:
The registrable name a subdomain belongs to, from the Public Suffix List with its private section (`mail.example.co.uk` is under `example.co.uk`, never `co.uk`; `alice.github.io` is its own). DMARC's relaxed alignment compares organizational domains. RFC 9989 replaces the list with a DNS tree walk; that change is not decided (`docs/adr/OPEN.md`). Not the "organisation" of a report sender or of a company (see **Organization**).
Home: `organizationalDomain`, `sameOrganizationalDomain` and `domainAncestry` (the names from a domain up to its organizational domain: report filing and `domains.parent_id`) in `packages/dns-checks/src/org-domain.ts`.

**Effective policy**:
The DMARC policy receivers apply to mail from ONE name, and where it comes from: the name's own record's `p=`; else the organizational domain's `sp=` when the name exists or `np=` when it does not exist (NXDOMAIN), then `sp=`, then `p=` (RFC 9989 sections 4.10.1 and 4.7; an invalid `sp=` makes the record `p=none`). It is never the parent's `p=` read for a subdomain. Every level, grade and verdict for a name takes it from `DmarcLookup.effective`.
Home: `effectivePolicy` in `packages/dns-checks/src/effective-policy.ts`, reached through `lookupDmarc` in `packages/dns-checks/src/dmarc.ts`; existence in `packages/dns-checks/src/name-exists.ts`. The dashboard's `policyInForce` in `packages/dns-checks/src/dmarc-next-step.ts` reads the stored facts built from it (`dmarcFactsFromLookup` in `src/email/dns-snapshot.ts`).
_Avoid_: inherited policy (say which tag and which record), "the policy" without a name

**Alignment**:
Whether the domain SPF or DKIM authenticated is the same as the From domain: relaxed means the same organizational domain, strict the identical domain (RFC 9989 sections 3.2.10.1 and 3.2.10.2). The SPF identifier is the return-path (MAIL FROM) domain, never the From domain, and the DKIM identifier is the signature's `d=`. A message fails DMARC when neither identifier aligns, even if both passed. The receiver's own verdict is stored per record (`spf_aligned`, `dkim_aligned`, and the report's `aspf` and `adkim`, migration 0022); the sentence for the identifier that did not align, and the fix at the right place, is one function.
Home: `aligned`, `alignmentVerdict`, `explainAlignment` in `packages/dns-checks/src/alignment.ts`; what a missing SPF record at a name means: `packages/dns-checks/src/spf-identity.ts`.

**Failing source (whose failure it is)**:
Every source whose mail failed DMARC is one of three, by one function: `yours` (SPF or DKIM passed for a name of the owner's organizational domain: the owner's to fix), `service_not_set_up` (a known sending service, or a source whose SPF and DKIM both passed for its own domains: a real service sending as the owner's domain without being set up for it; one thing to look at, never called spoofing) and `not_yours` (everything else: nothing to fix, outside mail). The next step, the names panel, Analytics and the agent report read the same class.
Home: `classifySource`, `serviceNotSetUpSentence` in `packages/dns-checks/src/sender-providers.ts` (`likelyNotYours` is a reading of it); the counts: `failed_not_yours`, `failed_service` in `packages/db/src/queries/reports.ts`.
_Avoid_: "likely mail pretending to be…" for a service that passed SPF and DKIM for its own domains

**Reports reach a name**:
How reports reach a name, as one answer (`reach` on the report-address view): `own` (connected, its own record lists our address), `via_parent` (no connection of its own; the intake files the reports that name it under its row through a connected parent), `inherited_record` (no DMARC record of its own, and the record that applies to it, its organizational domain's, already sends reports here: its mail is counted in that domain's reports) or `none`. Every surface says it in the same words with the real counts (`reportReachWords`), and none offers "Connect reports" for a name whose reports already arrive. A connected name with a counted report stored for it, before or since it was connected, is receiving, never "waiting for the first report".
Home: `reportReachOf` in `src/hosted/report-address.ts`; words in `packages/dns-checks/src/report-reach.ts`; the web reads `reachWords` and `reportsArrive` in `web/src/lib/report-address.ts`.

**Verdict**:
The one-line judgement of a domain shown to a person (verified, needs attention, unknown…) with its reason.
Home: `domainVerdict` in `web/src/lib/verdict.ts`; words in `STATUS` in `packages/ui/src/components/status.tsx`.

**Standing**:
Where a domain stands overall: the verdict plus freshness, hosted state, parent, report window and uncounted reports. Not one module yet; `web/src/lib/verdict.ts` is the closest and other rules remain (`docs/single-sources.md`).
_Avoid_: health, status (alone)

**Next step**:
The one action the person should take next for a domain. Several producers today, which can disagree. The DMARC policy step: `dmarcSteps` in `packages/dns-checks/src/dmarc-next-step.ts` (the dashboard and the agent report's `dmarc.next_step`; from `p=quarantine` at `pct=100` it offers `p=reject` once 90% of mail passes, `READY_FOR_REJECT`, below `pct=100` it offers raising `pct`; the record text is `dmarcRecordFor`). The policy wizard's staged rollout: `planNextStep` in `src/dmarc/rollout.ts` (adds `t=y` steps). The agent's proposed fix: `enforcedDmarc` in `packages/report/src/fixes.ts`, which keeps `p=quarantine` at `pct=100` and never proposes reject, so the agent can see two different offers. See `docs/single-sources.md`.
_Avoid_: recommendation, guidance, to-do

## Reports

**Report** (aggregate):
A DMARC aggregate (RUA) report a mailbox provider sends about one domain for one day; TLS-RPT reports are separate.
_Avoid_: digest (that is our weekly email), PDF (that is the export)
Home: parsing `src/dmarc/`, storing `packages/db`.

**Report address** — **four forms**:
Where a domain's DMARC record sends reports (`rua=mailto:…`).
1. **Hosted, shared:** `rua@<INTAKE_DOMAIN>`, the same for every customer, routed by the domain inside the report (ADR 0006). Built by `fixedReportAddress` in `src/hosted/fixed-address.ts`; connected by `connectReports` and written into a DMARC record only by `applyReportRecord`, both in `src/hosted/report-address.ts` (ADR 0020). Ours is only ever the first or the second address of a record, never the third. Only for a proven domain of a workspace that `HOSTED_CONNECT_REPORTS` admits: by default (`owner`) only the operator's own workspaces (the account of `OWNER_EMAIL`). For any other hosted customer the DMARC record is written without our address and reports cannot be connected.
2. **Hosted, per token:** `rua+<token>@<INTAKE_DOMAIN>` (and `tls-rpt+<token>@…`), built by `intakeAddress` in `src/hosted/tokens.ts`. Used by hosted records (`buildHostedDmarc` in `src/hosted/records.ts`, set up by `enableHosted` and rotated by `rotateHostedToken` in `src/hosted/service.ts`), and still accepted for a domain given one before the shared address existed.
3. **Self-host:** `rua@<reports domain>`, the install's own reports domain. Built inline in `src/domains/service.ts`, `src/domains/bulk.ts`, `src/api/router.ts`, `src/onboarding/plan.ts` and `src/digest/weekly.ts`.
4. **Agent and public report:** `dmarc@<domain>`, the domain's own mailbox, never ours. Proposed by `enforcedDmarc` and the fix values in `packages/report/src/fixes.ts`, and by the report catalog and renderer (`packages/report/src/catalog/dmarc-missing.ts`, `packages/report/src/catalog/dmarc-p-none-no-rua.ts`, `packages/report/src/render-md.ts`).
_Avoid_: RUA email, inbox

**TLS report**:
A TLS-RPT (RFC 8460) JSON report a sending mail server sends about one domain: how many sessions used TLS, how many failed and why, per policy type. It is the evidence that MTA-STS works, but only a **counted** one: RFC 8460 requires a valid DKIM signature by the reporting domain, so a report counts when its mail is authenticated and from a known reporter (the registry's TLS identity of Google or Microsoft, decided by the same rule as DMARC reports: `decideTier` in `src/dmarc/reporter-auth.ts`); every other report is stored and shown, labelled, and never moves the enforce decision. It is evidence because the Worker cannot open a connection to a customer's mail server (no outbound port 25). On the hosted service the address is `tls-rpt@<INTAKE_DOMAIN>`, built by `tlsReportAddress` in `src/hosted/fixed-address.ts`, routed by `policies[].policy.policy-domain` to the proven owner whose MTA-STS is on (`peekTlsPolicyDomain` and `attributeTlsReport` in `src/hosted/tls-intake.ts`); self-host: `tls-rpt@<reports domain>`. Each stored report keeps the sessions of MTA-STS policies apart (`stsStats` in `src/email/tls-rpt.ts`).
_Avoid_: DMARC report (those are the aggregate reports above)
Home: `handleTlsRptReport` in `src/email/tls-rpt.ts`; the numbers `reports.tlsSummary` and `reports.tlsEvidence` (counted reports only) in `packages/db`.

**Policy host**:
The hostname `mta-sts.<domain>` that serves a domain's MTA-STS policy over HTTPS from this Worker, and how it gets a certificate a sender trusts (RFC 8461 section 3.3): `worker_route` (a proxied CNAME in the same Cloudflare account) or `saas_hostname` (a DNS-only CNAME and a Cloudflare for SaaS custom hostname in the operator's zone; every policy host is reached through the ONE route the hosted deploy config declares). It answers one request, the policy file; everything else on it is a 404. It is **served** only when Ready Set Mail has fetched the policy address and got the exact policy (`fetchPolicyProof` in `src/mta-sts/reconcile.ts`); it is **retired** (served as `mode: none` until senders' cached policy has expired) when its domain is removed, loses proof or is evicted (`src/mta-sts/retire.ts`). The word "policy server" in older code comments means this.
_Avoid_: MTA-STS server, policy endpoint
Home: `strategyFor` and `OperatorZone` in `src/mta-sts/policy-host.ts`; serving `src/mta-sts/serve.ts`; which workspace owns a name `resolvePolicyHost`, also in `src/mta-sts/serve.ts` (there is one `policy-host.ts`, in `src/mta-sts/`). Decision: ADR 0026.

**Connect reports** and **review**:
The action that files a hosted domain's reports here: it sets the domain's report address (`connectReports`) and, where a Cloudflare connection reaches the zone, adds our address to its DMARC record. A review is what that write would do to the record in the zone now (`reviewReportRecord`: the record now, the record after, a hash of the live value); the Apply carries the reviewed hash and the person's choice, never a record, and is refused (`record_changed`) when the live record is not the one reviewed.
_Avoid_: publish (for a write we make)
Home: `src/hosted/report-address.ts`; panel `web/src/components/reports/ConnectReports.tsx`; ADR 0020.

**Intake**:
Receiving report mail: authenticating the sender, attributing the report to a workspace, applying caps, storing.
Home: hosted `src/hosted/intake.ts`; self-host and shared parts `src/email/handler.ts`, `src/dmarc/reporter-auth.ts`.

**Counting mode**:
Which received reports count toward a domain's numbers: `registry` (known reporters only), `authenticated`, or `all`. Default: `registry` when `MODE=saas`, `all` otherwise; `REPORT_COUNTING` overrides it.
Home: `reportCounting` in `src/dmarc/counting.ts` (the one place the default is decided); the type `CountingMode` in `packages/db/src/queries/counting.ts`. `packages/db` also falls back to `registry` when a caller passes no mode (no caller relies on it today).

## Accounts

**Sign-up attempt** (pending account):
Between "Create account" and the right code, nothing exists but one row of `verifications`: `startAttempt` in `src/auth/codes.ts` stores the address, the purpose, the code's MAC, the tries, the password hash typed, the invite and the terms version, keyed by a handle in the browser's pending cookie. When product analytics is on it also holds a small tag (`$.an`: the analytics id minted for this attempt, the resend count, the time of the first code, the sign-up source and whether it came from the checker), written by `src/product-analytics/auth.ts`. It expires after `CODE_SECONDS` (10 minutes) and is deleted when the code is used; the account, its workspace and membership are created only then. No other sign-up field survives.
Home: `src/auth/codes.ts`; `verifications` in `packages/db/src/schema.ts`; routes `src/auth/routes.ts`.

## Product analytics

**Product analytics**:
The hosted service's own counts of the steps people take from sign-up to a paid fix (an event such as `Records Live`), sent server-side from the Worker to PostHog after the response. Off unless `MODE=saas` and `POSTHOG_KEY` and `POSTHOG_HOST` are set; a self-hosted installation never sends. No browser script, cookie or storage; events carry only categories and buckets from a closed allow-list, never an address, a domain or an id of a customer (ADR 0008). `path` on a setup event means how the domain's ownership was proven (`cloudflare` or `manual`), `records_by` who wrote the records (`apply` or `hand`).
_Avoid_: telemetry (the opt-in self-host telemetry was removed; its endpoint never resolved), tracking, usage stats, the website's browser analytics (Plausible, a different thing)
Home: `src/product-analytics/` (`capture.ts` the one sender, `events.ts` the allow-list, `steps.ts` and `auth.ts` the hooks the server actions call, `identity.ts` the analytics id and the once-only markers); `scripts/posthog-setup.mjs` for the funnels; `docs/analytics.md`; ADR 0008.

**Analytics id**:
`settings.analytics_id`: one random UUID per workspace, made by the Worker (`crypto.randomUUID()`, never derived from an email, a domain, a user or a workspace id and never chosen by a link), used as the `distinct_id` of every event about the workspace. A sign-up by email code mints it with the pending attempt and the new workspace adopts it. The once-only markers (`analytics:live:<domain id>`, `analytics:applied:<domain id>`) are rows in the same `settings` table.
_Avoid_: visitor id, user id, person id (events are personless)
Home: `src/product-analytics/identity.ts` (`analyticsIdFor`, `adoptAnalyticsId`, `claimMarker`).

## Selling and agents

**Offer** and **order**:
The offer is the priced service, today one: "Fix one domain" (ADR 0013; the amount always comes from the Stripe price, intended $149). An order is one purchase of it by a workspace.
An order becomes **paid** only in `applyInvoice` in `src/billing/sync.ts`, after it re-reads the invoice from Stripe and Stripe says paid. Three callers reach it: Stripe's webhook (`src/billing/webhook.ts`: `invoice.paid`, and `invoice.payment_action_required` or `invoice.payment_failed` when the re-read invoice is paid); `failOrder` when an invoice it was about to fail turns out paid (the purchase itself can take this path); and the daily reconcile, `runBillingJob` in `src/billing/reconcile.ts` (the hosted cron at 11:00 UTC, orders pending for over an hour, 25 per run). Pressing Pay never marks an order paid on its own.
_Avoid_: plan, subscription, package
Home: `src/billing/offer.ts`, order states `src/billing/orders.ts`; `docs/billing.md`.

**Agent**:
An AI client acting for a person through the MCP server or the API, with finite grants the person consented to. The MCP tools never write DNS. Two change state: `add_domain` (`addDomain` in `src/mcp/tools/index.ts`: `assertAgentEnrollmentSafe` in `src/domains/service.ts` first, which refuses with 409 when another workspace holds an unproven `legacy` row for the name, because taking it over needs a signed-in person; then `enrollDomain`) and `verify_domain`. Both can, as a side effect of the ownership rule, withdraw another workspace's lapsed zone proof and email that workspace's owners (`sendProofLostNotice`), although the tool descriptions and the consent page say they send no mail.
_Avoid_: bot, integration
Home: `src/mcp/`, grants `src/access/`; `docs/agent-operations.md`.

**App** (an agent's software) and **app registration**:
The assistant or program an agent connection is made through (Claude, ChatGPT, Cursor, VS Code). An app introduces itself in one of two ways: it publishes a **client ID metadata document** at its own HTTPS address (the app is then **verified** by that host), or it **registers itself** with `POST /oauth/register` (dynamic client registration; off unless the operator sets `MCP_DCR_ENABLED=1`; the app is then **not verified**, its name is a claim). Registration is vetted, counted and audited, and an app nobody approves is deleted after 24 hours (ADR 0022). A person is told who an app is by what can be checked, never by the name it chose: the publisher's host for a verified app, otherwise the address it sends them back to ("an app on this computer" for loopback); the name it gave is shown as what it **calls itself**. An approved app appears in Settings → Agents under that address. Nothing is pre-ticked on its approval page, whichever way it introduced itself. A connection is **live** until it is revoked or reaches its end date; only live ones count toward the ceiling on apps and toward the limits of one person (20 live apps, 20 approvals in 24 hours) and one workspace (50 live apps) (`src/mcp/connection-limits.ts`); an ended connection's record is deleted 7 days later by the daily clean-up. A **refresh token** is used once, and used again within 30 seconds (its **grace window**) it gets the same new tokens, so two calls that refresh together keep their connection; used later, or an older one, it ends the connection (`src/mcp/refresh-replay.ts`).
_Avoid_: client (in UI copy), plugin
Home: `src/mcp/registration.ts`, the names an app may use and the reserved ones `src/mcp/client-names.ts`, `src/mcp/connections.ts` (`clientIdentity`); the list of assistants `web/src/lib/agent-clients.ts`; `docs/agent-operations.md`.
