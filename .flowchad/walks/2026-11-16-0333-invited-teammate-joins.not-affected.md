# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`
- **Reason:** The change adds one read route to the router, `GET /api/domains/:id/names` (the subdomains seen in a domain's reports), and its import. No invite, sign-in, code, membership or domain-list route changes, and the teammate's two screens (the invite page and the overview) are untouched: nothing a teammate sees or does on this flow differs.
- **By:** Claude (agent), for review by Max F. Findel
- **Date:** 2026-11-16
