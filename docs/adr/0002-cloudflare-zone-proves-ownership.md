---
status: accepted
date: 2026-11-15
decided-by: owner
---
# A domain in an active zone of a connected Cloudflare account is owned by that fact

When a workspace's Cloudflare connection holds the domain's zone (active, full setup, in the connection's account, DNS editable, public name servers equal to the zone's), that proves ownership; no TXT record is asked for. Anything else falls back to the TXT record `_readysetmail.<domain>` with `readysetmail-verify=`, or to a proven parent. Owner, 2026-11-15, after connecting Cloudflare: "why have a domain select at all? why not auto add them".

**Consequences**
- One module decides ownership: `src/domains/ownership.ts` (`cloudflareProof`, `admitByZone`, `verifyClaim`, `provenByTxt`). The full rule is in `docs/cloudflare-oauth.md`.
- A second ownership check anywhere else is a bug; `test/agent-memory/single-sources.test.ts` guards the TXT label.
