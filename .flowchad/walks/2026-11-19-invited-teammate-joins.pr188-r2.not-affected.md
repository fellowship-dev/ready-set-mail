# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`, `web/src/pages/domains/OverviewPage.tsx`
- **Reason:** This PR's edit to `router.ts` moves the MTA-STS routes to `src/mta-sts/routes.ts`; the invite, accept and members routes are not in its diff, and the invite pages and `MembersPage.tsx` are not touched. `OverviewPage.tsx` differs from PR 181's tip only by an import moved from `ProofLost` to `lib/proof`. Everything else in the list arrived by merging main, PR 181 (subdomains) and PR 184 (lifecycle emails) into this branch; This PR's own diff of mapped files is `git diff 18c1294 826c99b` (this branch right after main was merged in, before PR 181 and 184); it lists only the files named as edited by this PR here, and PR 181 and 184 carry their own records for their screens.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR #188; reviewer to accept
- **Date:** 2026-11-19
