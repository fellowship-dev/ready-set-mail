---
status: decided, not yet implemented in the data model
date: 2026-11-15
decided-by: owner
---
# A subdomain is part of its domain, never a sibling; a domain with all its subdomains counts as one domain

A subdomain shows up inside its domain's page, not as a row beside it: the domain list may carry a badge with the number of subdomains, and the overview says whether any of them needs attention. For pricing and scope a domain with all its subdomains is one domain: it counts once against the plan's domain limit and is sold once as "Fix one domain". Owner decision, 2026-11-15: "about subdomains, they should show up inside my domain, not as a sibling. The main domain list may have a badge of the amount of subdomains and the overview should tell me if any needs attention. For me this is included as 'one domain' btw, for pricing and scope."

**Status: NOT YET IMPLEMENTED in the data model.** Today every subdomain a workspace adds is a row of `domains` with its own `parent_id`, listed as an indented row under its nearest listed ancestor (`web/src/lib/listed-parent.ts`), counted against the plan limit (`domains_per_workspace` in `packages/db/src/queries/plan-limit.ts`) and buyable on its own (`src/billing/service.ts`). The first slice (this pull request) changes none of that. It fixes what the product says about subdomains (the effective policy of a name, alignment, the reports state, the return-path) and adds the names seen sending as a domain to the domain's page, read from the reports already stored.

**Consequences**
- The unit is the domain a workspace proves that has no proven ancestor in the same workspace up to its organizational domain (`organizationalDomain`, never a public suffix, so `alice.github.io` and `bob.github.io` are two). Every other name the workspace monitors under it is a subdomain of that unit. An agency that holds only `mail.client.com` has that name as its unit; if it later proves `client.com`, the unit count drops by one.
- Rows are not merged: history and the audit log hang off `domain_id`. The unit is derived (computed on read), and only three things change: what the plan limit counts, what the overview lists, and which row an order belongs to.
- A subdomain's mail without a DMARC record of its own is reported inside its organizational domain's report (RFC 9990 section 3.1.2), so an agency sees mail from `mail.client.com` only once `_dmarc.mail.client.com` exists. The product must say so and offer that exact record.
- The public scope sentences ("Fix one domain" in `src/billing/offer.ts`, the website and terms) must say "your domain and every subdomain under it", with the five-service cap of ADR 0013. That wording is an open owner decision (`docs/adr/OPEN.md`).
- Follow-up slices, each its own pull request with a decision record where it needs one: (2) one effective-policy module used by every judge, the report's the policy domain and the discovery method of each report stored; (3) units for counting and billing, the plan limit and "Fix one domain" per unit, the offer wording; (4) the domain list badge and the overview's attention roll-up; (5) discovery from the zone's records, the reports and certificate transparency, never asking a person to pick subdomains; (6) lock-down of names that do not send (`np=`, null MX, `v=spf1 -all`) through an explicit apply (ADR 0004), and the agency messaging.
