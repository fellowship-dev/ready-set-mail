---
status: accepted
date: 2026-11-16
decided-by: owner, 2026-11-16 (wiki D-48, L-091); the price is open (O-13)
---
# SPF flattening is an add-on, per domain; its price is open

Owner, Nov 16: "Spf is a continuous work. Its an add on and it needs its own price, per domai[n]." SPF flattening is a separately priced per-domain add-on, not part of pay as you go and not only inside the Fix one domain job. **No price is set and no price text is written anywhere** (O-13 in [OPEN.md](OPEN.md): it needs a price with a basis).

**What this change decides**
- One answer to "may this workspace use it": `addOnAccess(env, 'spf_flattening', { workspaceId, domainId })` in `src/hosted/plan-limits.ts`, returning `{ allowed, reason }`. Every route, `/api/me` (`add_ons.spf_flattening`), the daily job and the next-step link ask it.
- **Self-host**: available. **Hosted**: only for a workspace the operator admitted with `HOSTED_SPF_FLATTENING` (default off; `owner`, `all`, or a comma list of workspace ids), parsed by the one allow-setting parser `src/hosted/allow.ts` that `HOSTED_CONNECT_REPORTS` also uses. Everyone else on hosted sees nothing: no card, no next-step link, the routes answer 404 and write nothing. This keeps D-48 ("hidden on hosted until its refresh works") true while the refresh now works.
- **Turning off is never refused.** A workspace that loses access while a domain is flattened keeps the card, the record as it was, and Turn off (which restores the original).
- `domainId` is in the signature so the plan (`HOSTED_PLAN`, #180) can attach a subscription item per domain later; what a lapse does is an open question named in `docs/spf-flattening.md` (keep the last good record and stop refreshing, restore the original, or a grace period).

**Consequences**
- Operator steps to admit a workspace are in `docs/spf-flattening.md` and `docs/hosted.md`.
- The same pattern is the home for the other add-ons the owner named (MTA-STS, BIMI): add an `AddOn` and its setting.
