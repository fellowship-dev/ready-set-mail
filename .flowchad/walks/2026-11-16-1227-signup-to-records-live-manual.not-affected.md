# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`
- **Reason:** Only the response shape of `GET /api/domains/:id/sources` changed (the failing-senders list gains the one-check and not-recorded groups). Nothing on this flow reads that route: it is read by the domain page's failing-senders panel and by the agent tools, and none of this flow's screens or steps calls it.
- **By:** Claude Fable 5.2 (reviewer to accept or reject)
- **Date:** 2026-11-16
