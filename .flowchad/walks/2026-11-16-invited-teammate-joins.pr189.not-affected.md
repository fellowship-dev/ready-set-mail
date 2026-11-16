# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`, `web/src/pages/domains/OverviewPage.tsx`
- **Reason:** `src/api/router.ts`: I read `git diff db9527e -- src/api/router.ts`. The SPF flattening routes (enable, disable, preview, check now, adopt, discard) sit behind one capability check and call `src/spf/refresh.ts`; `GET /api/me` gains an `add_ons` key (the clients that read it only read `spf_flattening`); the hand-edit refusal of `apply-spf` has a truer sentence; two DNS reads use `resolverFor(env)`. No sign-up, code, invite, join, member, ownership, connection or onboarding route changes behaviour. `OverviewPage.tsx` passes the workspace's add-on flag (`useAddOns().spf_flattening`) to the verdict of each domain row, which decides only whether a row whose SPF record is over the limit offers the flattening link or the by-hand page; the invite, the code step, the join page and the hand-off card are untouched. Proof at this commit: `test/trust/roles-and-gating.test.ts`, the invite and hand-off specs in `npm run test:web` and the node suites, and the full `bash scripts/e2e-devbox.sh` pass.
- **By:** Claude (Opus 5.5) for Max F. Findel, the SPF flattening pull request (round 2); reviewer to accept or reject
- **Date:** 2026-11-16
- **Commit:** 02845926ecc1c27c481df6183f898a6bc4dd056b
