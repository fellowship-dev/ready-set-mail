# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`
- **Reason:** The router changes are the self-host-only table (`PUT /api/domains/:id/set-default` now answers 404 in hosted mode), one shared test for whether a Cloudflare connection reaches a domain's zone (onboarding-status), and the DNS resolver that two domain routes use (honours DOH_BASE_URL like the onboarding plan). No invite, sign-in, code, membership or overview route, response or screen of this flow is touched; an invited teammate reads the same pages and meets no new control.
- **By:** Claude Fable 5.2, author of this change (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-16
