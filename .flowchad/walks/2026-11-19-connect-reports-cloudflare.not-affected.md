# Not affected: connect-reports-cloudflare

- **Flow:** connect-reports-cloudflare
- **Changed:** `src/api/router.ts`
- **Reason:** The change deletes the free-check follow-up sequence (ADR 0025). In `src/api/router.ts` it removes the `handleLeadRoutes` call and its import and one line of the route list comment, so `GET /api/leads` and `POST /api/leads/:id/stop` (instance owner only, never called by this flow) now fall through like any unknown path. The routes this flow uses (the domain's report-address status, review and apply, and the DNS check) are not touched and no response they give changes. I read `git diff origin/subdomains-slice1 HEAD -- src/api/router.ts`: those three lines are the whole change to the file.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR #184; reviewer to accept
- **Date:** 2026-11-19
