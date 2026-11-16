# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `web/src/pages/wizards/setup/SpfStep.tsx`
- **Reason:** `src/api/router.ts`: see the invited-teammate-joins record, same diff: SPF flattening routes, the `/api/me` `add_ons` key, the `apply-spf` sentence and two DNS reads through `resolverFor(env)`; none of the sign-up, ownership, claim or onboarding routes of this flow is in it. `SpfStep.tsx`: one sentence changes, in the state "SPF flattening is on", which a first-run domain never has (flattening is a later, optional tool); the steps, fields and actions of the manual path are untouched. Proof: `npm run test:web` (`web/test/setup-wizard.test.tsx`, `web/test/setup-domain.test.tsx`) and the node suites for onboarding and auth pass.
- **By:** Claude (Fable 5.2) for Max F. Findel, the SPF flattening pull request; reviewer to accept
- **Date:** 2026-11-16
