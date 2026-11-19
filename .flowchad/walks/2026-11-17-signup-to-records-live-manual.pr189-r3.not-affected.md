# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`, `web/src/app.tsx`, `web/src/pages/wizards/setup/SpfStep.tsx`
- **Reason:** Of these files only `web/src/pages/wizards/setup/SpfStep.tsx` differs between the previously judged commit (de8d943, record `2026-11-17-signup-to-records-live-manual.pr189-merge.not-affected.md`) and this one (`git diff --stat de8d943 HEAD -- <the five files>` lists that file alone; I read `git diff de8d943 HEAD -- web/src/pages/wizards/setup/SpfStep.tsx`). The change is inside the "Over the 10-lookup limit" alert of the SPF step: it ends with a link (to the flattening page where flattening is offered, to "See where the lookups go" where it is not) and, where flattening is not offered, the sentence no longer says "or flatten the record". The alert is shown only when the record being proposed needs more than 10 lookups; this flow's path (sign-up, the first domain, connecting, the records going live) never proposes such a record and shows the step unchanged: same fields, same words, same order. Proof at this commit: `web/test/setup-wizard.test.tsx` (admitted, not admitted, self-host) and the rest of `npm run test:web` pass; the full `bash scripts/e2e-devbox.sh` passes.
- **By:** Claude (Opus 5.5) for Max F. Findel, the SPF flattening pull request (round 3); reviewer to accept or reject
- **Date:** 2026-11-17
- **Commit:** 1533e256a6f9ad81e26f1bad0184ee99c34cfb4c
