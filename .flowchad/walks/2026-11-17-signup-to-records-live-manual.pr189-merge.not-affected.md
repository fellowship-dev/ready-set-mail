# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`, `web/src/app.tsx`, `web/src/pages/wizards/setup/SpfStep.tsx`
- **Reason:** Main's #186 (agents connect) changed `web/src/app.tsx` only inside `Gate`: when the address carries `?continue=` (an app's approval page asking a signed-out person to sign in, `web/src/lib/resume.ts`), the dashboard keeps that request and, after sign-in with a workspace, sends the person back to it. Nothing else in `Gate` changes: with no `?continue=` the sign-up and sign-in screens, their order, fields and words are the ones already judged. Of the files listed here, only `web/src/app.tsx` differs between the previously judged head (37d154d) and this merge (`git diff --name-only 37d154d HEAD`); the others are this pull request's SPF flattening work, judged in the earlier record. I read `git diff 37d154d HEAD -- web/src/app.tsx`.
- **By:** Claude (Opus 5.5) for Max F. Findel, merging main (#186) into the SPF flattening pull request; reviewer to accept or reject
- **Date:** 2026-11-17
- **Commit:** de8d943a225a075a7904f2f33c03f02130d01ad6
