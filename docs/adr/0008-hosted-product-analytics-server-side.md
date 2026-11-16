---
status: accepted, not yet on main (PR #178)
date: 2026-11-15
decided-by: owner ("We will need to track usage. Posthog sounds good." 2026-11-14)
---
# Product analytics: server-side events to PostHog, hosted app only, a random id per workspace

The hosted app sends usage events to PostHog from the Worker, never from the browser, under one random UUID per workspace; no email, name, domain or amount is sent. A self-hosted installation sends nothing. On `main` today the app sends no product analytics: `src/telemetry.ts` is an opt-in self-host heartbeat whose endpoint does not resolve.

**Consequences**
- When PR #178 merges, its module becomes the only PostHog caller; add it to `docs/single-sources.md` and the guard in the same PR.
- The marketing website's analytics are decided in the website repository, not here.
