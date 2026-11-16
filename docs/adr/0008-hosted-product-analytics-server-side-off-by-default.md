---
status: accepted
date: 2026-11-14
decided-by: owner decision, 2026-11-14
---
# Hosted product analytics, when enabled, are sent server-side from the Worker to PostHog; off by default

The hosted service counts the steps from sign-up to a paid fix (PR #178) from the Worker, after the response, straight to PostHog. Nothing is sent unless it is turned on, and a self-hosted installation never sends anything.

**Consequences**
- The module is `src/product-analytics/`. It is on only with `MODE=saas`, `POSTHOG_KEY` (the public project key) and `POSTHOG_HOST`; self-host never sends, whatever it sets, and `npm run setup` sets neither.
- Server-side capture never goes through a proxy on the product's own domain: a Worker's request to its own zone forwards the visitor's address ("In same-zone Worker subrequests, the value of `CF-Connecting-IP` reflects the value of `x-real-ip` (the client's IP).", https://developers.cloudflare.com/fundamentals/reference/http-headers/). So `POSTHOG_HOST` accepts only PostHog's own ingestion hosts, `https://us.i.posthog.com` or `https://eu.i.posthog.com`. A local fake for tests is the separate, testing-only `POSTHOG_API_BASE`.
- No browser script, cookie or storage: the dashboard loads nothing from PostHog and keeps nothing about analytics on the visitor's device. Events carry categories and buckets from a closed allow-list under one random id per workspace, with no person profile.
- It replaced the opt-in self-host telemetry (its source file was deleted; its endpoint never resolved).
- Events, the allow-list and the funnels are in `docs/analytics.md`.
