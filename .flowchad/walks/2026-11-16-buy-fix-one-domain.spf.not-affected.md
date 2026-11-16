# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `web/src/pages/domains/DomainDetailPage.tsx`
- **Reason:** I read `git diff 61e6b8f -- web/src/pages/domains/DomainDetailPage.tsx`: it adds one line that reads the workspace's SPF flattening add-on (`useAddOns`), passes it to `useSpfFlatten` as its `enabled` flag and into the next-step input (`spfFlattening`), and folds it into `toolsShown`. It touches nothing of the offer card, the card step, the confirm step, the payment or the order (`FixOffer`, `src/billing/*` and `web/src/components/billing/*` are not in the diff). On the hosted service with the setting unset (the default) the page is the same as before for this flow; I walked the domain page of a hosted workspace in that state at 375 and 1440 (the steps "hosted, HOSTED_SPF_FLATTENING unset" in the spf-flattening walk record) and the offer-bearing sections are unchanged. Proof the page still works: `npm run test:web` (`web/test/domain-detail.test.tsx`, `web/test/billing.test.tsx`) passes.
- **By:** Claude (Fable 5.2) for Max F. Findel, the SPF flattening pull request; reviewer to accept
- **Date:** 2026-11-16
