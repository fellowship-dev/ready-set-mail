# Open decisions

Not decided. Do not build as if they were; ask the owner, then record the answer as an ADR and delete the line here.

| Decision | Today on `main` | Options on the table |
|---|---|---|
| **Level ladder** (which rungs the product shows) | Two ladders: the dashboard's three rungs (Delivering / Authenticated / Protected) and the agent report's four (Unprotected / Monitoring / Enforced / Hardened). See `docs/single-sources.md`. | Dashboard's three rungs (coordinator's pick) or the agent's four. One ladder in `packages/dns-checks` either way. |
| **Sign-in code lifetime** | 10 minutes (`CODE_SECONDS` in `src/auth/codes.ts`). | Keep, or lengthen so the code outlives a slow inbox. |
| **Open hosted reports to every customer** | `HOSTED_CONNECT_REPORTS=owner` by default: only the operator's own workspaces may connect reports (`src/hosted/fixed-address.ts`). | `all`, after large-report handling, forged-report weighting and storage caps are judged ready (`docs/hosted.md`). |
| **Hosted cron jobs** | Five crons (`wrangler.jsonc`, `src/cron.ts`): three run once per workspace (08:00 and 10:00 daily, the Monday 09:00 digest); 04:00 (data lifecycle) runs once; 11:00 runs per workspace and, on the hosted service, the hosted job once (`src/hosted/cron.ts`, including billing's reconcile and, proposed in [ADR 0026](0026-mta-sts-customer-zone-records-and-saas-policy-host.md), the MTA-STS refresh). | Which jobs the hosted service runs, and how often. Not decided: ADR 0026 proposes running the MTA-STS refresh in the 11:00 hosted job. |
| **Client access request** (an agency asks a client for DNS access) | Not built. | A request link the client opens without an account: connect Cloudflare to the agency's workspace, or get records to paste. |
| **Hosted plan pricing** | Plan caps are variables (`src/hosted/plan-limits.ts`); the only priced item is Fix one domain (`src/billing/offer.ts`). | Free tier and paid plans: not decided. |
| **Fix one domain scope wording** | `OFFER_SCOPE` in `src/billing/offer.ts` still says the job moves DMARC to reject, which contradicts ADR 0013. | The exact replacement sentence (owner to approve), then one change to `offer.ts` and every place that repeats it. |
