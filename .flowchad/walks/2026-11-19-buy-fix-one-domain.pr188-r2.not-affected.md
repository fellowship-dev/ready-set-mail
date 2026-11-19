# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `web/src/components/billing/FixOffer.tsx`, `web/src/pages/domains/DomainDetailPage.tsx`
- **Reason:** `FixOffer.tsx` is identical to PR 181's tip (`git diff f59fff8 HEAD` is empty for it). This PR's own edit to `DomainDetailPage.tsx` is the DNS tools disclosure: its summary line and whether the MTA-STS card is listed on hosted. It is below the fix offer and no step of the flow (the offer, the card, the order, the fixed domain) reads it. Everything else in the list arrived by merging main, PR 181 (subdomains) and PR 184 (lifecycle emails) into this branch; This PR's own diff of mapped files is `git diff 18c1294 826c99b` (this branch right after main was merged in, before PR 181 and 184); it lists only the files named as edited by this PR here, and PR 181 and 184 carry their own records for their screens.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR #188; reviewer to accept
- **Date:** 2026-11-19
