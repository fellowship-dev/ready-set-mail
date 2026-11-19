---
status: accepted
date: 2026-11-16
decided-by: the coordinator, 2026-11-16 (round 2 of PR 189, after the independent review found that a provider answering `v=spf1 -all` was written at once)
---
# A refresh never removes an authorised address on its first sighting; a removal waits four hours

SPF flattening rewrites a customer's record every day without anyone watching. A provider's DNS can glitch (an outage page answering `v=spf1 -all`, a half-published record). Writing that at once removes the provider's senders from the customer's record until the next daily run: up to a day of failed mail from a glitch of minutes. So **a refresh never removes an authorised address on its first sighting.**

**The rule**
- Per provider (each inlined top-level include of the original) the refresh compares what the published record authorises for it with what the new resolution would. A provider kept as an include is authorised live: we remove nothing from it. For an inlined provider the removed set is its old inlined entries that no new entry covers (an address or range is covered by an equal or wider range of its kind; any other term by the same term).
- Nothing removed: write at once. Additions are safe.
- Something removed: write now the new record **plus the entries whose removal is pending**, when that combined record fits both limits (10 lookups, 450 bytes). So additions land at once and nothing is taken away. If it does not fit, **write nothing** (the additions wait too, and the page says so). The row is marked pending with the removal set (`pending_removed`, by provider), `pending_since` and whether the additions were written (`pending_additions`).
- The removal is **confirmed**, and the record written in full, only when a later run sees **the same removal set again at least four hours after the first sighting**. A different removal set replaces the pending one and the clock restarts. No removal clears the pending state (the provider came back) with no write.
- **Threshold = 0:** every removal waits, including a provider that loses all its addresses (the page names the provider). Basis: holding a removal costs no delivery (the held addresses are ones receivers accepted yesterday; they stay authorised a few more hours), while writing a wrong removal fails mail. Additions are never held.
- **N = 4 hours.** Basis: TTLs of provider SPF records measured from their authoritative servers on 2026-11-16 (`dig TXT @authoritative`): `_spf.google.com` 300 s, `spf.brevo.com` 300 s, `_spf.mlsend.com` 300 s, `spf.protection.outlook.com` 600 s, `servers.mcsv.net` 600 s, `mailgun.org` 900 s, `amazonses.com` 900 s, `sendgrid.net` 1,800 s, `_spf.salesforce.com` 3,600 s, `mail.zendesk.com` 3,600 s, `spf.mandrillapp.com` 14,400 s (the longest). Four hours is at least the longest TTL, so the second look is a fresh answer from the provider, not a cached copy of the first one. The daily job normally makes the second look the next day; "Check again now" lets the owner confirm sooner once four hours have passed (before that it says it will confirm after HH:MM UTC).

**Consequences**
- Audit rows: `spf_flatten.pending` (first sighting, with the removed set; again, with `replaced`, when a different set takes its place), `spf_flatten.update` on confirmation (meta `confirmed_after_seconds`), `spf_flatten.pending_cleared` (the provider came back).
- A real removal reaches the record four hours to a day later than before. That is the price of not failing mail on a glitch; it is the owner's mail that is protected, not the provider's.
- The rule is one function (`decideSpfWrite`, `src/spf/refresh.ts`), used by the customer's refresh and by the hosted records' daily refresh (`hosted_domains.spf_state`). The card and the page say what waits, how many addresses are held, whether the additions were written, when the next check can confirm, and why four hours; "Check again now" is the same check (before the time it answers when it can confirm, after it, it confirms or clears).
- Additive migration: `provider_state` (what the published record authorises per inlined include), `pending_removed`, `pending_since`, `pending_additions` on `spf_flatten_config` (migration 0025). The code is `refreshSpf` in `src/spf/refresh.ts` and `removed` / `held` in the engine (`packages/dns-checks/src/spf-flatten.ts`). Details: `docs/spf-flattening.md`.
- Extends ADR 0027 (one refresh engine); changes nothing in ADR 0028.
