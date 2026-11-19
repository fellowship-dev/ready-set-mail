# Not affected: connect-reports-cloudflare

- **Flow:** connect-reports-cloudflare
- **Changed:** `src/api/router.ts`, `src/hosted/fixed-address.ts`, `src/hosted/report-address.ts`, `web/src/components/ReportsNotConnected.tsx`, `web/src/components/domain/DnsRecords.tsx`, `web/src/components/domain/DoThisNext.tsx`, `web/src/components/reports/ConnectReports.tsx`, `web/src/components/reports/ReachStatement.tsx`, `web/src/components/reports/SourceRow.tsx`, `web/src/lib/report-address.ts`, `web/src/pages/domains/DomainDetailPage.tsx`, `web/src/pages/domains/OverviewPage.tsx`
- **Reason:** This change touched `src/api/router.ts` only for the pay-as-you-go plan (the add-domain refusal status, a plan sync after a domain is removed), behind `HOSTED_PLAN=pay_as_you_go`, unset by default; connecting reports is untouched. Every other file in the list comes from the merged subdomains-slice1 (#181), which carries its own walk records for them. **No walk was run for this pull request**: this record is a judgement, not a walk, and the reviewer accepts or rejects it.
- **By:** Claude Opus 5.5 (the reviewer accepts or rejects the reason)
- **Date:** 2026-11-19
