# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `src/api/router.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`, `web/src/lib/first-day.ts`, `web/src/pages/wizards/cloudflare/FirstScreen.tsx`, `web/src/pages/wizards/setup/DmarcStep.tsx`, `web/src/pages/wizards/setup/SpfStep.tsx`
- **Reason:** This change touched `src/api/router.ts`, `src/domains/ownership.ts` and `src/domains/service.ts` only for the pay-as-you-go plan (the one async `domainCap`, the refusal status, a plan sync after a domain is proven or removed). All behind `HOSTED_PLAN=pay_as_you_go`, unset by default: with it unset the caps, answers and words are identical, so the first-run steps are unchanged. The other files in the list come from the merged subdomains-slice1 (#181), which carries its own walk records for them. **No walk was run for this pull request**: this record is a judgement, not a walk, and the reviewer accepts or rejects it.
- **By:** Claude Opus 5.5 (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-19
