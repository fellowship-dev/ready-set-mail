# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `src/domains/ownership.ts`, `web/src/app.tsx`, `web/src/lib/first-day.ts`, `web/src/pages/wizards/cloudflare/FirstScreen.tsx`, `web/src/pages/wizards/setup/DmarcStep.tsx`, `web/src/pages/wizards/setup/SpfStep.tsx`
- **Reason:** This PR's only edit to these files is `router.ts` (the MTA-STS routes move to `src/mta-sts/routes.ts`; no sign-up, claim or ownership route changes). The other six are not in this PR's own diff (they come from the merges). Everything else in the list arrived by merging main, PR 181 (subdomains) and PR 184 (lifecycle emails) into this branch; This PR's own diff of mapped files is `git diff 18c1294 826c99b` (this branch right after main was merged in, before PR 181 and 184); it lists only the files named as edited by this PR here, and PR 181 and 184 carry their own records for their screens.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR #188; reviewer to accept
- **Date:** 2026-11-19
