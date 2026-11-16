# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `web/src/pages/domains/DomainDetailPage.tsx`
- **Reason:** I read `git diff db9527e -- web/src/pages/domains/DomainDetailPage.tsx` (9 lines): it reads the add-on (`useAddOns`), passes `spfFlattening` and `spfFlat` into the next-step input, adds the one-line `SpfStatusLine` under the header (only when flattening is on or off-and-available), and drops `hostedMode` from that input. The offer card, the card step, the confirm step, the payment and the order (`FixOffer`, `web/src/components/billing/*`, `src/billing/*`) are not in the diff. A workspace without the add-on (the default on hosted) sees the same page for this flow: I walked that state, the domain page of a hosted workspace without the add-on, at 375 and 1440 (step 1 of `.flowchad/walks/2026-11-16-spf-flattening.hosted-open.md`). Proof at this commit: `npm run test:web` (`web/test/domain-detail.test.tsx`, `web/test/billing.test.tsx`) and the full `bash scripts/e2e-devbox.sh` pass.
- **By:** Claude (Opus 5.5) for Max F. Findel, the SPF flattening pull request (round 2); reviewer to accept or reject
- **Date:** 2026-11-16
- **Commit:** 02845926ecc1c27c481df6183f898a6bc4dd056b
