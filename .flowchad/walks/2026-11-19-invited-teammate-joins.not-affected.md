# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`, `web/src/pages/domains/OverviewPage.tsx`
- **Reason:** This change touched `src/api/router.ts` only for the pay-as-you-go plan (the add-domain refusal status, a plan sync after a domain is removed), behind `HOSTED_PLAN=pay_as_you_go`, unset by default; invites, hand-off and joining are untouched. `web/src/pages/domains/OverviewPage.tsx` comes from the merged subdomains-slice1 (#181), which carries its own walk records for it. **No walk was run for this pull request**: this record is a judgement, not a walk, and the reviewer accepts or rejects it.
- **By:** Claude Opus 5.5 (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-19
