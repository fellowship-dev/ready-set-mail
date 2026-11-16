# Not affected: signup-to-records-live-cloudflare

- **Flow:** signup-to-records-live-cloudflare
- **Changed:** `src/api/router.ts`, `src/auth/signup-policy.ts`, `src/connections/import.ts`, `src/connections/routes.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`
- **Reason:** With `HOSTED_PLAN` off (the default) nothing a person sees or does on this flow changes. With it on, the FIRST domain, the one the person typed or the zone matching their sign-up email, is still imported with no question and no price: `importZones` imports the typed domain (new optional `preferred_domain` in the request; the first-run screens that PR #177 changes do not send it yet and get the old behaviour of importing what fits or `needs_selection` with one choice and Next) and returns the zones that did not fit as `other_zones`, which no first-run screen renders. Sign-up now records the person's free allowance on their first workspace (`signup-policy.ts`, no visible change); `ownership.ts` only marks an evicted holder's plan for the daily repair; `service.ts` asks the one plan module for room. `test/connections` and `test/plan` pass.
- **By:** Claude (Fable 5.2) for Max F. Findel, hosted-plan-payg phase 1 (server side); reviewer to accept
- **Date:** 2026-11-16
