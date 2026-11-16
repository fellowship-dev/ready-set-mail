---
status: accepted (built behind HOSTED_PLAN, switched on by the operator)
date: 2026-11-16
decided-by: owner
---
# The hosted dashboard is free for one domain per person, and pay as you go for more

Owner decisions of 2026-11-16: "C. Free for one domain, with a paid plan for more", "with limits of course, to prevent single domain abuse"; "1 domain per workspace and you cannot create new workspace unless you upgrade to pay as you go. You can get invited to an existing one though"; "if they are the only domain of a client, they remain free forever" (a client who owns their own workspace with their one domain is free; the agency is invited into it); "$5 per extra domain a month, $50 a year: yes" (a starting hypothesis); "still can't add credit card? This should be solved. It's a sub with a 5usd product in it." Still in force: billing "exactly as fly.io" (the card on Stripe's hosted page, then back; one card per workspace; no custom payment UI; a button in the product), and a domain with all its subdomains is ONE domain (2026-11-15).

**The model.** A *unit* is an organizational domain with all its subdomains. Each person holds one free unit (the *allowance*), in exactly one workspace they own. A workspace on **Pay as you go** has one Stripe subscription whose quantity is its billable units: units minus the allowance it holds, never negative. Joining a workspace is always free and never uses an allowance. Another workspace is created free of the allowance when the person already pays somewhere, or after adding a card (the workspace does not exist until the card is verified). The operator's own workspaces are exempt. Reading and export are never blocked: over a limit or after a lapse the data stays, and domains beyond the free one are *paused* (new reports not processed, shown to the owner as not processed). Nothing is deleted for non-payment. The setting is `HOSTED_PLAN` (`off` by default).

**Consequences**
- Pricing is a hypothesis: $5 a month, $50 a year, in two Stripe prices found by lookup key (`rsm_extra_domain_monthly`, `rsm_extra_domain_yearly`); the amount always comes from Stripe. The dashboard offers monthly only for now; the server accepts `interval: "year"`.
- The server is the only writer of the quantity (ADR 0015). The browser never sends a quantity or a price.
- "Hosted plan pricing" leaves `OPEN.md`.
- Separate accounts each get one free domain; only the existing sign-up controls (bot check, emailed codes, auth limits) bound that. A cap on swapping the free domain, blocking disposable addresses and a members cap are not built; their triggers are in the memo.
