# Decisions

Short records of decisions already made, with who made them. A change that contradicts one needs a new record that supersedes it. Undecided questions are in [OPEN.md](OPEN.md); do not build on them.

| # | Decision | Status |
|---|---|---|
| 0001 | [Sign-in is a password plus a 6-digit emailed code, limited by daily caps](0001-sign-in-password-and-emailed-code.md) | accepted |
| 0002 | [A domain in an active zone of a connected Cloudflare account is owned by that fact](0002-cloudflare-zone-proves-ownership.md) | accepted |
| 0003 | [Connecting Cloudflare imports every active zone and writes nothing to DNS](0003-cloudflare-import-adds-all-active-zones-and-writes-nothing.md) | accepted |
| 0004 | [DNS writes happen only after an explicit Apply](0004-dns-writes-need-an-explicit-apply.md) | accepted |
| 0005 | [A workspace can hold several Cloudflare connections, shown by account](0005-several-cloudflare-accounts-per-workspace.md) | accepted |
| 0006 | [Hosted customers publish one shared report address](0006-one-shared-hosted-report-address.md) | accepted, owner sign-off not recorded |
| 0007 | [Billing: one card per workspace, Stripe-hosted pages, the webhook decides paid](0007-billing-one-card-per-workspace-stripe-hosted.md) | accepted |
| 0008 | [Product analytics: server-side to PostHog, hosted only, random id per workspace](0008-hosted-product-analytics-server-side.md) | accepted, PR #178 |
| 0009 | [Emails carry no remote images](0009-emails-carry-no-remote-images.md) | accepted |
| 0010 | [A filled brand-blue surface means "press this" or "you are here"](0010-filled-brand-blue-means-action.md) | accepted |
| 0011 | [Reviews judge what can happen with today's customers](0011-reviews-judge-todays-customers.md) | accepted |
| 0012 | [Map the flow to its value moment before designing or changing screens](0012-map-flows-to-value-before-screens.md) | accepted |
| 0013 | [Fix one domain ends at DMARC monitoring with reports, not at reject](0013-fix-one-domain-is-c1-without-reject.md) | accepted, code not aligned |

Format: [Matt Pocock's ADR format](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/ADR-FORMAT.md) (title, one to three sentences, consequences), plus `status`, `date` and `decided-by`.
