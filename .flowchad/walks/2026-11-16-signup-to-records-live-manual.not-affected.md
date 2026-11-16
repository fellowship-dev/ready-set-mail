# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `src/auth/signup-policy.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`
- **Reason:** With `HOSTED_PLAN` off (the default) nothing a person sees or does on this flow changes. With it on, adding the FIRST domain (typed, then proven by the TXT record) is unchanged and shows no price; only a second domain answers `402 plan_required` (a paid confirm that the dashboard half builds in the next phase). Sign-up records the allowance (no visible change); `ownership.ts` and `service.ts` ask the one plan module for room; `router.ts` plans the setup wizard's base-domain step the same way (the wizard's first domain is free). `test/hosted`, `test/hardening` and `test/plan` pass.
- **By:** Claude (Fable 5.2) for Max F. Findel, hosted-plan-payg phase 1 (server side); reviewer to accept
- **Date:** 2026-11-16
