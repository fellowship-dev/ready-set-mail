# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `web/src/pages/domains/DomainDetailPage.tsx`
- **Reason:** `DomainDetailPage.tsx` differs from main only in the DNS tools disclosure at the bottom of the page: MTA-STS is asked for everywhere (the server says whether it can be turned on) instead of being switched off on hosted, the section stays hidden when neither tool is available or set up, and its summary line names the tools it lists. That disclosure is collapsed and below the first screen on this path; no step, field, button or word before it changed. The offer, its price and the checkout are not in the diff.
- **By:** Claude (Fable 5.2) for Max F. Findel, the MTA-STS hosted PR (merge of PR 183); reviewer to accept
- **Date:** 2026-11-16
