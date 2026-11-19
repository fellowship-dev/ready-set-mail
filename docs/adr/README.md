# Decisions

Short records of decisions already made, with who made them. A change that contradicts one needs a new record that supersedes it. Undecided questions are in [OPEN.md](OPEN.md); do not build on them.

| # | Decision | Status |
|---|---|---|
| 0001 | [Hosted sign-in is a password plus a 6-digit emailed code, limited by daily caps](0001-sign-in-password-and-emailed-code.md) | accepted |
| 0002 | [A domain in an active zone of a connected Cloudflare account is owned by that fact](0002-cloudflare-zone-proves-ownership.md) | accepted |
| 0003 | [Connecting Cloudflare imports every proven zone and writes nothing to the importer's DNS](0003-cloudflare-import-adds-all-active-zones-and-writes-nothing.md) | accepted, superseded in part by 0014 |
| 0004 | [A domain's own DNS records change only when a person asks](0004-dns-writes-need-an-explicit-apply.md) | accepted, SPF refresh narrowed by 0026 |
| 0005 | [A workspace can hold several Cloudflare connections, shown by account](0005-several-cloudflare-accounts-per-workspace.md) | accepted |
| 0006 | [Hosted customers that connect reports publish one shared report address](0006-one-shared-hosted-report-address.md) | accepted, owner sign-off not recorded |
| 0007 | [Billing: one card per workspace, Stripe-hosted pages, Stripe decides paid](0007-billing-one-card-per-workspace-stripe-hosted.md) | accepted |
| 0008 | [Hosted product analytics, when enabled, are sent server-side from the Worker to PostHog; off by default](0008-hosted-product-analytics-server-side-off-by-default.md) | accepted |
| 0009 | [Emails carry no remote images of ours](0009-emails-carry-no-remote-images.md) | accepted |
| 0010 | [A filled brand-blue surface means "press this" or "you are here"](0010-filled-brand-blue-means-action.md) | accepted |
| 0011 | [Reviews of the hosted service judge what can happen with today's customers](0011-reviews-judge-todays-customers.md) | accepted |
| 0012 | [Map the flow to its value moment before designing or changing screens](0012-map-flows-to-value-before-screens.md) | accepted |
| 0013 | [Fix one domain ends at DMARC monitoring with reports, not at reject](0013-fix-one-domain-is-c1-without-reject.md) | accepted, code not aligned |
| 0014 | [An agency's Cloudflare connection imports only the zone of the client being set up](0014-agency-connection-imports-only-the-client-zone.md) | accepted, owner to confirm |
| 0020 | [One function writes our report address into a DMARC record](0020-one-function-writes-the-report-address.md) | accepted |
| 0021 | [MTA-STS writes the customer's own records and is served from a Cloudflare for SaaS policy host](0021-mta-sts-customer-zone-records-and-saas-policy-host.md) | proposed: owner confirms |
| 0022 | [Apps introduce themselves by a published document, or by a registration that is vetted, counted and audited](0022-apps-introduce-themselves-by-document-or-by-vetted-registration.md) | accepted |
| 0023 | [A subdomain is part of its domain, never a sibling; a domain with all its subdomains counts as one domain](0023-a-subdomain-is-part-of-its-domain.md) | decided, not yet implemented in the data model |
| 0024 | [A person removed from, leaving, or left by a deleted workspace keeps their account](0024-removed-or-leaving-keeps-the-account.md) | accepted |
| 0025 | [Remove the leads follow-up sequence](0025-remove-the-leads-follow-up-sequence.md) | accepted |
| 0026 | [SPF flattening has one refresh engine, and it resolves the stored original](0026-one-spf-flattening-refresh-engine.md) | accepted, "never rewritten" narrowed by 0029 |
| 0027 | [SPF flattening is an add-on, per domain; its price is open](0027-spf-flattening-is-an-add-on-per-domain-price-open.md) | accepted, price open |
| 0028 | [A refresh never removes an authorised address on its first sighting; a removal waits four hours](0028-a-refresh-never-removes-an-address-on-first-sighting.md) | accepted |
| 0029 | [After an edit made outside the app, the owner chooses: use it as the new original, or discard it](0029-the-owner-may-adopt-an-outside-edit-as-the-new-original.md) | accepted |

Format: [Matt Pocock's ADR format](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/ADR-FORMAT.md) (title, one to three sentences, consequences), plus `status`, `date` and `decided-by`.
