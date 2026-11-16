# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`
- **Reason:** The change deletes the free-check follow-up sequence (ADR 0015). In `src/api/router.ts` it removes the `handleLeadRoutes` call and its import, so `GET /api/leads` and `POST /api/leads/:id/stop` (instance owner only, never called by this flow) now fall through like any unknown path; no route this flow uses is touched and no response it gets changes. In `web/src/app.tsx` it removes the lazy `LeadsPage` import and the `leads` route: the operator's Leads page, which no screen of this flow links to or reaches (the nav item was removed in `Shell.tsx`, not on this flow). I read `git diff` of both files: nothing else changed in them. Proof: `npm test -- --run` (including `test/api`, `test/auth`, `test/funnel/free-check.test.ts`, which checks `/api/leads` answers 404), `npm run test:web` and the full `bash scripts/e2e-devbox.sh` (the sign-up, first-run, hand-off and Cloudflare specs) pass.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR #184; reviewer to accept
- **Date:** 2026-11-16
