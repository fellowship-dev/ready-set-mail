---
status: accepted
date: 2026-11-15
decided-by: owner
---
# A domain in an active zone of a connected Cloudflare account is owned by that fact

When a workspace's Cloudflare connection holds the domain's zone (active, full setup, in the connection's account, DNS editable, public name servers equal to the zone's, not a public suffix, and, on the hosted service, no other workspace holding the name or a parent or child of it), that proves ownership; no TXT record is asked for. Anything else falls back to the TXT record `_readysetmail.<domain>` with `readysetmail-verify=` (the old prefix `inboxangel-verify=` is still accepted), or to a proven parent. Owner, 2026-11-15, after connecting Cloudflare: "why have a domain select at all? why not auto add them".

**Consequences**
- One module decides ownership: `src/domains/ownership.ts` (`admitDomain`, `cloudflareProof`, `admitByZone`, `verifyClaim`, `provenByTxt`, `isDomainProven`). The full rule is in `docs/cloudflare-oauth.md`.
- The proof columns are still read in other files (`docs/single-sources.md`, "Reads and writes of the proof columns"); `test/agent-memory/single-sources.test.ts` fails on a new one and on the TXT prefix anywhere else.
