// The guard lists behind docs/single-sources.md, read by test/agent-memory/single-sources.test.ts.
//
// Two kinds of guard:
//  - SINGLE: only the owning files or folders (a trailing `/`) may contain the signature. A site anywhere else fails.
//  - MUST_NOT_GROW: a concept that is still duplicated today. `sites` is exactly today's files, so a NEW file fails, and a file
//    that no longer matches (consolidated, renamed or moved) must be taken off or renamed here (the list only shrinks).
// Signatures describe the construct (a column, a host, an import, the shape of a record or an address), not one spelling of it.
// They match production code only, with comments removed: see `isProduction` in the test for what is not scanned.
//
// Every list here must equal the table in docs/single-sources.md: the counts, and the sites listed under "Sites, by concept".
//
// Escape hatch: ALLOW. A reviewed exception is one entry with the concept, the file, why, who and the date, in the same pull
// request that adds the site. It is not a skip flag: an entry for a file that no longer matches fails, so it cannot outlive its
// reason unnoticed. Prefer extending the owning module; use ALLOW only when the reviewer agrees a second site is right for now.

export interface Single { concept: string; signature: RegExp; owners: string[] }
export interface Duplicate { concept: string; signature: RegExp; authoritative: string; sites: string[] }
export interface Allow { concept: string; file: string; reason: string; by: string; date: string }

export const LIST_FILE = 'test/agent-memory/single-sources.lists.ts';

/** Single today: only these files or folders may contain the signature. */
export const SINGLE: Single[] = [
  {
    concept: 'Stripe API calls',
    // the API host, the SDKs, the client and its constants, the secret key and Stripe.js: not only a URL literal
    signature: /api\.stripe\.com|\bSTRIPE_API(?:_VERSION)?\b|\bstripeApiBase\b|new StripeClient\(|['"]Stripe-Version['"]|\.STRIPE_SECRET_KEY\b|from ['"](?:stripe|@stripe\/[^'"]+)['"]|require\(['"](?:stripe|@stripe\/)|js\.stripe\.com/,
    owners: ['src/billing/'],
  },
  {
    concept: 'PostHog sends (none on main; PR #178 adds the module)',
    // PostHog's hosts, its SDKs, its capture path and a read of the host setting; never a bare `/batch/` (Cloudflare has one too)
    signature: /posthog\.com|\.POSTHOG_(?:HOST|APP_HOST)\b|['"]posthog-(?:js|node)['"]|\/i\/v0\/e\b/i,
    owners: ['src/product-analytics/', 'scripts/posthog-setup.mjs'],
  },
  {
    concept: 'Cloudflare API calls (Worker: CfClient; plus the installer and the operator scripts)',
    signature: /api\.cloudflare\.com/,
    owners: ['src/tenancy/cf-client.ts', 'scripts/setup/cloudflare.mjs', 'scripts/setup-email-routing.ts', 'scripts/setup-email-routing.mts', 'scripts/enable-email-routing-shared-zone.mts'],
  },
  { concept: 'Ownership proof by TXT record', signature: /readysetmail-verify=/, owners: ['src/domains/ownership.ts'] },
  { concept: 'Public Suffix List (registrable domain)', signature: /(?:from|require\()\s*['"]tldts['"]/, owners: ['packages/dns-checks/src/org-domain.ts'] },
  // Consolidated in the subdomain slice: the five sites that took the last two labels now call `organizationalDomain`.
  { concept: 'Registrable domain (never "last two labels")', signature: /slice\(-2\)\.join\('\.'\)/, owners: ['packages/dns-checks/src/org-domain.ts'] },
  // `hasCname` is how a dangling CNAME (NXDOMAIN with a CNAME in the answer) counts as an existing name: one rule, `nameExists`.
  { concept: 'Name existence (NXDOMAIN with a CNAME exists)', signature: /\.hasCname\b/, owners: ['packages/dns-checks/src/name-exists.ts'] },
];

/** Still duplicated today: exactly these files. Consolidation order: docs/single-sources.md. */
export const MUST_NOT_GROW: Duplicate[] = [
  {
    concept: 'DMARC record builders',
    // a DMARC record with a policy, as one string, an array of tags or a concatenation
    signature: /v=DMARC1\s*;?\s*[`'"]?\s*[,+]?\s*[`'"]?\s*p=/,
    authoritative: 'packages/dns-checks/src/dmarc-next-step.ts',
    sites: [
      'packages/dns-checks/src/dmarc-next-step.ts', 'packages/dns-checks/src/dmarc-rua.ts', 'packages/dns-checks/src/report.ts',
      'packages/report/src/catalog/dmarc-missing.ts', 'packages/report/src/fixes.ts',
      'src/analytics/readiness.ts', 'src/dmarc/dns-record.ts', 'src/hosted/records.ts', 'src/onboarding/dmarc-plan.ts', 'src/setup/email-routing.ts',
      'web/src/lib/dmarc-record.ts', 'web/src/lib/reports.ts',
    ],
  },
  {
    concept: 'DMARC next-policy ladder',
    signature: /^export (const|function) (ROLLOUT_SEQUENCE|dmarcSteps|planNextStep|getNextStep)\b/m,
    authoritative: 'packages/dns-checks/src/dmarc-next-step.ts',
    sites: ['packages/dns-checks/src/dmarc-next-step.ts', 'src/dmarc/rollout.ts'],
  },
  {
    concept: 'DMARC record validation',
    signature: /^export function dmarcRecordProblem/m,
    authoritative: 'packages/dns-checks/src/dmarc-problem.ts',
    sites: ['packages/dns-checks/src/dmarc-problem.ts', 'src/dmarc/dns-record.ts'],
  },
  {
    concept: 'Exported SPF/DKIM/DMARC record parsers and judges',
    signature: /^export (async )?(function|const) (parse|is|enforcement)\w*(dmarc|spf|dkim)\w*/im,
    authoritative: 'packages/dns-checks/src/',
    sites: [
      'packages/dns-checks/src/dkim.ts', 'packages/dns-checks/src/dmarc-problem.ts', 'packages/dns-checks/src/dmarc-tags.ts', 'packages/dns-checks/src/dmarc.ts',
      'packages/dns-checks/src/spf-terms.ts', 'packages/dns-checks/src/spf.ts',
      'src/dmarc/dns-record.ts', 'src/dmarc/parse-email.ts', 'src/dmarc/rollout.ts', 'web/src/lib/dkim.ts', 'web/src/lib/dmarc-record.ts',
    ],
  },
  {
    concept: 'Domain standing ("needs attention") rules',
    // a judgement that a domain needs attention, or a pass-rate threshold written as a number
    signature: /status: 'attention'|[Rr]ate !== null && \w*[Rr]ate < 0\.\d/,
    authoritative: 'web/src/lib/verdict.ts',
    sites: ['packages/dns-checks/src/dmarc-next-step.ts', 'web/src/lib/actions.ts', 'web/src/lib/pdf/recommendations.ts', 'web/src/lib/verdict.ts'],
  },
  {
    concept: 'Domain enrollment inserts',
    signature: /domains\.insert\(|baseDomain\.apply\(|INSERT INTO domains\b|\.insert\(domains\)/,
    authoritative: 'src/domains/service.ts',
    // packages/db holds the two insert implementations themselves; the callers are the duplicates
    sites: ['packages/db/src/queries/base-domain.ts', 'packages/db/src/queries/domains.ts', 'src/api/router.ts', 'src/domains/bulk.ts', 'src/domains/service.ts'],
  },
  {
    concept: 'Reads and writes of the proof columns (the "proven" rule restated)',
    // any use of the columns the ownership rule reads, whatever the form of the predicate
    signature: /\b(?:verified_via|verifiedVia|proof_lost_at|cf_name_servers)\b/,
    authoritative: 'src/domains/ownership.ts',
    sites: [
      'packages/db/src/queries/base-domain.ts', 'packages/db/src/queries/claims.ts', 'packages/db/src/queries/domains.ts', 'packages/db/src/queries/export.ts',
      'packages/db/src/queries/intake.ts', 'packages/db/src/queries/plan-limit.ts', 'packages/db/src/schema.ts',
      'src/api/router.ts', 'src/billing/service.ts', 'src/domains/bulk.ts', 'src/domains/ownership.ts', 'src/domains/proof-recheck.ts', 'src/domains/service.ts',
      'src/email/dmarc-report.ts', 'src/hosted/report-address.ts', 'src/onboarding/domains.ts',
      'web/src/components/domain/ProofLost.tsx', 'web/src/lib/types.ts',
    ],
  },
  {
    concept: 'Untrusted Authentication-Results reads (sender trust)',
    signature: /extractAuthResults\(/,
    authoritative: 'src/email/sender-proof.ts',
    sites: ['src/email/free-check.ts', 'src/email/parse-headers.ts', 'src/hosted/canary.ts'],
  },
  {
    concept: 'Counting mode default',
    signature: /counting: CountingMode = |opts\.counting \?\?/,
    authoritative: 'src/dmarc/counting.ts',
    sites: ['packages/db/src/queries/analytics.ts', 'packages/db/src/queries/index.ts', 'packages/db/src/queries/reports.ts'],
  },
  {
    concept: 'Report address construction',
    // `rua@…`, `dmarc@…`, `rua+<token>@…` as a template, a literal or a concatenation, and `${kind}+${token}@…`
    signature: /(?<![\w.+-])(?:rua|dmarc)(?:\+[^@\s'"`]*)?@(?:\$\{|\{[a-z]|[a-z0-9-]+\.[a-z])|['"`](?:mailto:)?(?:rua|dmarc)[+@]['"`]\s*\+|\}\+\$\{\w+\}@/,
    authoritative: 'src/hosted/fixed-address.ts',
    sites: [
      'packages/report/src/catalog/dmarc-missing.ts', 'packages/report/src/catalog/dmarc-p-none-no-rua.ts', 'packages/report/src/fixes.ts', 'packages/report/src/render-md.ts',
      'scripts/seed-demo.ts',
      'src/api/router.ts', 'src/digest/weekly.ts', 'src/domains/bulk.ts', 'src/domains/service.ts', 'src/hosted/fixed-address.ts', 'src/hosted/tokens.ts', 'src/onboarding/plan.ts',
      'web/src/lib/reports.ts',
    ],
  },
  {
    concept: 'Level ladder (computing or naming rungs)',
    signature: /let level: Level = 0|\{ 0: 'Unprotected'|name: ["']Delivering["']|status = '(protected|exposed)'/,
    authoritative: 'none: owner to choose',
    sites: ['packages/dns-checks/src/report.ts', 'packages/ui/src/components/level-ladder.tsx', 'src/email/report-formatter.ts', 'web/src/lib/levels.ts'],
  },
  {
    concept: 'Verdict labels',
    signature: /(?:label|statusLabel)\s*[:=]\s*\{?\s*['"](?:Protected|At risk|Exposed|Needs attention)['"]|^\s*(?:protected|at_risk|exposed)\s*:\s*['"](?:Protected|At risk|Exposed)['"]/m,
    authoritative: 'packages/ui/src/components/status.tsx',
    sites: [
      'packages/ui/src/components/status.tsx', 'src/email/html-templates.ts', 'web/src/components/wizard/SeverityBadge.tsx', 'web/src/lib/reports.ts',
      'web/src/pages/leads/LeadsPage.tsx', 'web/src/pages/wizards/setup/RoutingStep.tsx',
    ],
  },
  {
    concept: 'DNS-over-HTTPS endpoints',
    signature: /cloudflare-dns\.com|dns\.google/,
    authoritative: 'packages/dns-checks/src/doh.ts',
    sites: ['packages/dns-checks/src/doh.ts', 'src/dmarc/ip-info.ts', 'src/public-reports/resolver.ts', 'tools/audit-fleet/lib/doh.ts'],
  },
  {
    concept: 'Fix-offer scope promising reject (contradicts ADR 0013)',
    signature: /moved to reject|move DMARC from none/,
    authoritative: 'src/billing/offer.ts',
    sites: ['src/billing/offer.ts', 'src/funnel/copy.ts'],
  },
];

/**
 * Reviewed exceptions. Each entry: the concept (exactly as above), the file, a reason of at least 20 characters and four words,
 * who agreed (the reviewer), and the date (YYYY-MM-DD, not in the future). Empty today.
 */
export const ALLOW: Allow[] = [];
