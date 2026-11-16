# Not affected: buy-fix-one-domain

- **Flow:** buy-fix-one-domain
- **Changed:** `web/src/pages/domains/DomainDetailPage.tsx`
- **Reason:** The offer card (`FixOffer`, below "Do this next"), its confirm step, the card step, Pay and every request and word of the purchase are untouched. The page change is the Connect reports panel inserted above "Do this next", only for a hosted domain that has no report address and can connect one; there the offer card sits one panel lower (about 300 px at 375 px wide), and once reports are connected the page is as before. Later commits of this branch also hide the "DNS tools" section (SPF flattening and MTA-STS) on hosted domains without hosted records; it sits at the bottom of the page, below the offer card, so it does not move the offer. The flow's steps and value moment (invoice paid) do not change. Billing is off on the local instances (no Stripe secrets), so this flow could not be walked there; the layout shift is the one thing a reviewer may want to weigh.
- **By:** Claude Fable 5.2, author of this change (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-16
