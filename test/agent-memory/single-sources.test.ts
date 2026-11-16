import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// "There is exactly one of these" (docs/single-sources.md), enforced. Two kinds of guard:
//  - single: only the owning module (or folder) may contain the signature. A new site anywhere else fails.
//  - must not grow: a concept that is still duplicated today. The list is exactly today's sites, so a NEW site fails, and a
//    site that goes away must be taken off the list (the list only shrinks, towards one).
// Signatures are matched on production code with full-line and trailing `//` comments removed. Tests are not scanned.
// When a guard fails: extend the owning module instead. If the change really is the consolidation, update the list here and
// the table in docs/single-sources.md in the same pull request.

const ROOT = join(__dirname, '../..');
const DIRS = ['src', 'web/src', 'packages/db/src', 'packages/dns-checks/src', 'packages/report/src', 'packages/ui/src', 'scripts', 'tools', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests']);

function sources(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(p);
    return /\.(ts|tsx|mts|mjs|js|cjs)$/.test(name) && !/\.(test|spec)\./.test(name) ? [p] : [];
  });
}

/** Removes full-line comments, block comments that start a line, and trailing `// …` comments (not `https://`). */
export function stripComments(text: string): string {
  let inBlock = false;
  return text.split('\n').map(line => {
    const s = line.trim();
    if (inBlock) { if (s.includes('*/')) inBlock = false; return ''; }
    if (s.startsWith('/*') && !s.includes('*/')) { inBlock = true; return ''; }
    if (s.startsWith('//') || s.startsWith('*') || (s.startsWith('/*') && s.endsWith('*/'))) return '';
    return line.replace(/(^|\s)\/\/(\s.*)?$/, '');
  }).join('\n');
}

const files = DIRS.flatMap(d => sources(join(ROOT, d))).map(p => ({ path: relative(ROOT, p), text: stripComments(readFileSync(p, 'utf8')) }));
const sitesOf = (signature: RegExp): string[] => files.filter(f => signature.test(f.text)).map(f => f.path).sort();

interface Single { concept: string; signature: RegExp; owners: string[] }
interface Duplicate { concept: string; signature: RegExp; sites: string[] }

/** Single today: only these files or folders (a trailing `/`) may contain the signature. */
export const SINGLE: Single[] = [
  { concept: 'Stripe API calls', signature: /api\.stripe\.com/, owners: ['src/billing/'] },
  { concept: 'PostHog sends (none on main; PR #178 adds the module)', signature: /posthog\.com|\/batch\//, owners: ['src/product-analytics/', 'scripts/posthog-setup.mjs'] },
  { concept: 'Cloudflare API calls (Worker: CfClient; plus the installer and the operator scripts)', signature: /api\.cloudflare\.com/,
    owners: ['src/tenancy/cf-client.ts', 'scripts/setup/cloudflare.mjs', 'scripts/setup-email-routing.ts', 'scripts/setup-email-routing.mts', 'scripts/enable-email-routing-shared-zone.mts'] },
  { concept: 'Ownership proof by TXT record', signature: /readysetmail-verify=/, owners: ['src/domains/ownership.ts'] },
  { concept: 'Public Suffix List (registrable domain)', signature: /from ['"]tldts['"]/, owners: ['packages/dns-checks/src/org-domain.ts'] },
];

/** Still duplicated today: exactly these sites. Consolidation order: docs/single-sources.md. */
export const MUST_NOT_GROW: Duplicate[] = [
  { concept: 'Level ladder (computing or naming rungs)', signature: /let level: Level = 0|\{ 0: 'Unprotected'|name: ["']Delivering["']|status = '(protected|exposed)'/,
    sites: ['packages/dns-checks/src/report.ts', 'packages/ui/src/components/level-ladder.tsx', 'src/email/report-formatter.ts', 'web/src/lib/levels.ts'] },
  { concept: 'DMARC record builders', signature: /\['v=DMARC1'|`v=DMARC1; p=\$\{|\[`v=DMARC1`/,
    sites: ['packages/dns-checks/src/dmarc-next-step.ts', 'packages/dns-checks/src/dmarc-rua.ts', 'packages/report/src/fixes.ts', 'src/analytics/readiness.ts', 'src/dmarc/dns-record.ts', 'src/hosted/records.ts', 'src/onboarding/dmarc-plan.ts', 'web/src/lib/dmarc-record.ts'] },
  { concept: 'DMARC next-policy ladder', signature: /^export (const|function) (ROLLOUT_SEQUENCE|dmarcSteps|planNextStep|getNextStep)\b/m,
    sites: ['packages/dns-checks/src/dmarc-next-step.ts', 'src/dmarc/rollout.ts'] },
  { concept: 'DMARC record validation', signature: /^export function dmarcRecordProblem/m,
    sites: ['packages/dns-checks/src/dmarc-problem.ts', 'src/dmarc/dns-record.ts'] },
  { concept: 'SPF/DKIM/DMARC record parsers and judges', signature: /^export (async )?(function|const) (parse|is|enforcement)\w*(dmarc|spf|dkim)\w*/im,
    sites: ['packages/dns-checks/src/dkim.ts', 'packages/dns-checks/src/dmarc-problem.ts', 'packages/dns-checks/src/dmarc-tags.ts', 'packages/dns-checks/src/dmarc.ts', 'packages/dns-checks/src/spf-terms.ts', 'packages/dns-checks/src/spf.ts',
      'src/dmarc/dns-record.ts', 'src/dmarc/parse-email.ts', 'src/dmarc/rollout.ts', 'web/src/lib/dkim.ts', 'web/src/lib/dmarc-record.ts'] },
  { concept: 'Domain standing ("needs attention") rules', signature: /status: 'attention'/,
    sites: ['packages/dns-checks/src/dmarc-next-step.ts', 'web/src/lib/actions.ts', 'web/src/lib/verdict.ts'] },
  { concept: 'Domain enrollment inserts', signature: /domains\.insert\(|baseDomain\.apply\(/,
    sites: ['src/api/router.ts', 'src/domains/bulk.ts', 'src/domains/service.ts'] },
  { concept: 'The "proven" rule restated (legacy verification)', signature: /verified_via\s*[!=]==?\s*'legacy'|verified_via = 'legacy'|verified_via, 'legacy'/,
    sites: ['packages/db/src/queries/claims.ts', 'packages/db/src/queries/intake.ts', 'packages/db/src/queries/plan-limit.ts', 'src/api/router.ts', 'src/domains/ownership.ts', 'src/domains/service.ts', 'src/email/dmarc-report.ts', 'src/hosted/report-address.ts', 'web/src/components/domain/ProofLost.tsx'] },
  { concept: 'Untrusted Authentication-Results reads (sender trust)', signature: /extractAuthResults\(/,
    sites: ['src/email/free-check.ts', 'src/email/parse-headers.ts', 'src/hosted/canary.ts'] },
  { concept: 'Counting mode default', signature: /counting: CountingMode = |opts\.counting \?\?/,
    sites: ['packages/db/src/queries/analytics.ts', 'packages/db/src/queries/index.ts', 'packages/db/src/queries/reports.ts'] },
  { concept: 'Report address construction', signature: /`rua@\$\{|`rua\+|`\$\{kind\}\+\$\{token\}@/,
    sites: ['src/api/router.ts', 'src/digest/weekly.ts', 'src/domains/bulk.ts', 'src/domains/service.ts', 'src/hosted/fixed-address.ts', 'src/hosted/tokens.ts', 'src/onboarding/plan.ts'] },
  { concept: 'Verdict labels', signature: /label: ['"](Protected|At risk|Exposed|Needs attention)/,
    sites: ['packages/ui/src/components/status.tsx', 'web/src/components/wizard/SeverityBadge.tsx', 'web/src/lib/reports.ts', 'web/src/pages/leads/LeadsPage.tsx'] },
  { concept: 'DNS-over-HTTPS endpoints', signature: /cloudflare-dns\.com|dns\.google/,
    sites: ['packages/dns-checks/src/doh.ts', 'src/dmarc/ip-info.ts', 'src/public-reports/resolver.ts', 'tools/audit-fleet/lib/doh.ts'] },
  { concept: 'Registrable domain by "last two labels"', signature: /slice\(-2\)\.join\('\.'\)/,
    sites: ['scripts/setup-email-routing.mts', 'scripts/setup-email-routing.ts', 'src/dmarc/ip-info.ts', 'src/dmarc/parse-aggregate.ts', 'tools/audit-fleet/lib/checker.ts'] },
  { concept: 'Fix-offer scope promising reject (contradicts ADR 0013)', signature: /moved to reject|move DMARC from none/,
    sites: ['src/billing/offer.ts', 'src/funnel/copy.ts'] },
];

describe('the comment stripper', () => {
  it('drops comments and keeps URLs in code', () => {
    expect(stripComments('// api.stripe.com\nconst a = 1; // api.stripe.com\n/* x\n api.stripe.com */\n * api.stripe.com')).not.toMatch(/stripe/);
    expect(stripComments("const u = 'https://api.stripe.com';")).toMatch(/api\.stripe\.com/);
  });
});

describe('single sources: one module each', () => {
  for (const s of SINGLE) {
    it(s.concept, () => {
      const strays = sitesOf(s.signature).filter(p => !s.owners.some(o => (o.endsWith('/') ? p.startsWith(o) : p === o)));
      expect(strays, `extend ${s.owners.join(', ')} instead`).toEqual([]);
    });
  }
});

describe('known duplicates: must not grow (docs/single-sources.md)', () => {
  for (const d of MUST_NOT_GROW) {
    it(d.concept, () => {
      expect(sitesOf(d.signature), 'a new site: extend an existing one; a removed site: take it off this list').toEqual([...d.sites].sort());
    });
  }
});

describe('the map and the guards agree', () => {
  const map = readFileSync(join(ROOT, 'docs/single-sources.md'), 'utf8');
  it('docs/single-sources.md names every guarded concept', () => {
    for (const c of [...SINGLE, ...MUST_NOT_GROW]) expect(map, c.concept).toContain(c.concept);
  });
});
