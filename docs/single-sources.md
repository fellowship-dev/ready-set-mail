# Single sources

There is exactly one of each concept below. Extend it; never add a second. `test/agent-memory/single-sources.test.ts` enforces the guarded rows: a new site fails the build. Terms are defined in `CONTEXT.md`.

## One module each

| Concept | Module | Entry points | Who may call | Guard |
|---|---|---|---|---|
| Ownership proof by TXT record (and the whole ownership rule) | `src/domains/ownership.ts` | `cloudflareProof`, `admitByZone`, `verifyClaim`, `provenByTxt` | domain service, Cloudflare import, claim routes | single-sources (TXT prefix) |
| Adding a domain (single add, agent tool, Cloudflare import) | `src/domains/service.ts` | `enrollDomain`, `commitVerifiedDomain` | routes, `src/mcp/tools/index.ts`, `src/connections/import.ts` | must-not-grow (bulk and the wizard still insert on their own) |
| Cloudflare API calls (Worker: CfClient; plus the installer and the operator scripts) | `src/tenancy/cf-client.ts` | `CfClient`, via `TenantContext.cfFor` | anything in `src/` that needs Cloudflare | single-sources; `test/tenancy/guards.test.ts` |
| DNS write rules | `src/dns/write-policy.ts` | `assertDnsWriteAllowed`, `assertHostedDnsWrite` | `CfClient`, hosted records | — |
| Cloudflare zone import | `src/connections/import.ts` | `importZones` | `src/connections/routes.ts` | — |
| Stripe API calls | `src/billing/` | `stripe-client.ts`; orders `orders.ts`; paid only by `webhook.ts` | billing routes | single-sources |
| PostHog sends (none on main; PR #178 adds the module) | `src/product-analytics/` once PR #178 merges | — | — | single-sources (already allows that folder) |
| Public Suffix List (registrable domain) | `packages/dns-checks/src/org-domain.ts` | `organizationalDomain` | everyone | single-sources |
| DNS lookups for checks (DNS-over-HTTPS) | `packages/dns-checks/src/doh.ts` | `createResolver` | everyone | must-not-grow |
| Hosted shared report address | `src/hosted/fixed-address.ts` | `fixedReportAddress`, `attributeReport` | intake, report-address routes | must-not-grow (report address construction) |
| Domain verdict | `web/src/lib/verdict.ts` | `domainVerdict` | overview, domain page, PDF, Get Started | must-not-grow (standing rules) |
| Verdict words | `packages/ui/src/components/status.tsx` | `STATUS` | every status badge | must-not-grow (verdict labels) |
| Offer text | `src/billing/offer.ts` | `OFFER_SCOPE`, `REFUND_RULE` | billing routes; the dashboard renders what the API sends | must-not-grow (offer scope) |

## Known duplicates: to be consolidated

Each row is guarded in "must not grow" form: the test lists exactly today's sites, so a new one fails and a removed one must come off the list. Counts are production files on `main` 6a7d775. The order is the recommended consolidation order (Wave 1, refreshed); each is one pull request with an independent review. Do not do these refactors as a side effect of other work.

| # | Concept | Sites | Authoritative today | What differs |
|---|---|---|---|---|
| 1 | DMARC record builders | 8 | `dmarcRecordFor` in `packages/dns-checks/src/dmarc-next-step.ts` | `fixes.ts` (agent fix) forces quarantine and its own report address; `src/dmarc/dns-record.ts` twins the dashboard builder; hosted, onboarding and readiness build their own |
| 1 | DMARC next-policy ladder | 2 | `dmarcSteps` in `packages/dns-checks/src/dmarc-next-step.ts` | `src/dmarc/rollout.ts` adds `t=y` steps and a 90% gate (readiness adds 98%, 100 messages, 7 days); the domain page shows both |
| 1 | DMARC record validation | 2 | `dmarcRecordProblem` in `packages/dns-checks/src/dmarc-problem.ts` | the Worker copy adds a length cap and strict tags |
| 1 | SPF/DKIM/DMARC record parsers and judges | 11 (6 in `packages/dns-checks`) | `packages/dns-checks` | dashboard `web/src/lib/dmarc-record.ts` and `dkim.ts`, Worker `rollout.ts`, `dns-record.ts`, `parse-email.ts` parse again |
| 2 | Domain enrollment inserts | 3 | `src/domains/service.ts` | bulk import (`src/domains/bulk.ts`) skips restore, product authorization and the agent safety check; the setup wizard inserts through `baseDomain.apply` |
| 3 | Untrusted Authentication-Results reads (sender trust) | 3 | `src/email/sender-proof.ts` and `src/dmarc/reporter-auth.ts` | the hosted email check (`canary.ts`) and the free-check reply read the untrusted header |
| 4 | The "proven" rule restated (legacy verification) | 9 | `src/domains/ownership.ts` | SQL and UI copies disagree on a Cloudflare proof without name servers; PR #177 adds a 10th site (`web/src/lib/first-day.ts`) |
| 5 | Domain standing ("needs attention") rules | 3 | `web/src/lib/verdict.ts` | `web/src/lib/actions.ts` repeats verdict sentences; the PDF keeps its own SPF/DKIM pass-rate rule (0.9 against 0.95) |
| 5 | Verdict labels | 4 | `packages/ui/src/components/status.tsx` | the email-check labels (protected / at risk / exposed) and the wizard badge repeat words |
| 6 | Level ladder (computing or naming rungs) | 4 | none: owner to choose (`docs/adr/OPEN.md`) | dashboard 0–2, agent report 0–3, email check per message |
| 7 | Report address construction | 7 | hosted: `fixedReportAddress` in `src/hosted/fixed-address.ts` | self-host addresses are built inline in the wizard, single add, bulk, onboarding and the digest |
| 8 | Counting mode default | 3 | `reportCounting` in `src/dmarc/counting.ts` | `packages/db` defaults to the hosted `registry` in three places (no caller relies on it today) |
| 9 | DNS-over-HTTPS endpoints | 4 | `packages/dns-checks/src/doh.ts` | `ip-info.ts` raw PTR fetch; public reports' own endpoints; `tools/audit-fleet` has its own client |
| 9 | Registrable domain by "last two labels" | 5 | `organizationalDomain` (Public Suffix List) | wrong for `co.uk`-style names |
| — | Fix-offer scope promising reject (contradicts ADR 0013) | 2 | `src/billing/offer.ts` | `src/funnel/copy.ts` describes the older 90-day Fix it; both need the owner-approved C1 wording |

**First: the DMARC record module (row 1).** It is the code that writes customers' DNS, it has the most copies (8 builders, 2 ladders, 2 validators), and the copies already disagree on what record to offer. It needs no owner decision. Rows 2 and 3 follow because they are authorization and forgery gaps; row 6 waits for the ladder decision.
