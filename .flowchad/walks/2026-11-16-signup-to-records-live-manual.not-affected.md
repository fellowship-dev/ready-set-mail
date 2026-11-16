# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`
- **Reason:** The change adds one read route to the router, `GET /api/domains/:id/names` (the subdomains seen in a domain's reports), and its import. Sign-up, the claim, the TXT proof, adding a domain and the records the person copies are unchanged, and none of the screens on this flow is touched (the changed dashboard files belong to the Cloudflare flow and the domain page, not to the manual wizard).
- **By:** Claude (agent), for review by Max F. Findel
- **Date:** 2026-11-16
