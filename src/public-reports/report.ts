// One public report: the free checker's DMARC, SPF and DKIM (common-selector scan) results for a domain, read from public DNS at one
// moment. Each check has its own DoH budget (resolver.ts); the whole read has a deadline, after which a check that has not answered is
// reported as a failed lookup (never as "no record").

import { COMMON_DKIM_SELECTORS, SPF_LOOKUP_LIMIT, SPF_VOID_LIMIT } from '@ready-set-mail/dns-checks';
import { checkDkim, checkDmarc, checkSpf, domainExists } from './check';
import { inertDeep } from './text';
import type { DkimResult, DmarcResult, SpfResult } from './types';

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_TOOLS = ['dmarc', 'spf', 'dkim'] as const;
export type ReportTool = (typeof REPORT_TOOLS)[number];

/** The whole DNS read stops here; the website's checker uses the same 10 seconds per request. */
export const REPORT_DEADLINE_MS = 10_000;

type Stamped<T, K extends ReportTool> = T & { tool: K; checkedAt: string };

/** Stored as result_json, schema version 1. Each result is the payload the website's checker renders. */
export interface PublicReportV1 {
  v: 1;
  domain: string;
  checkedAt: string;
  source: ReportTool;
  dmarc: Stamped<DmarcResult, 'dmarc'>;
  spf: Stamped<SpfResult, 'spf'>;
  dkim: Stamped<DkimResult, 'dkim'>;
}

const SLOW = 'The lookup took too long';

function timedOut(tool: ReportTool, domain: string): DmarcResult | SpfResult | DkimResult {
  const base = { state: 'lookup-failed' as const, domain, complete: false, findings: [], reason: SLOW };
  if (tool === 'dmarc') return { ...base, source: null, recordDomain: null, organizationalDomain: null, inherited: false, record: null, tags: null, grade: 'unknown' };
  if (tool === 'spf') return { ...base, record: null, recordLength: 0, verdict: null, totalLookups: 0, lookupLimit: SPF_LOOKUP_LIMIT, voidLookups: 0, voidLimit: SPF_VOID_LIMIT, includes: [], usesPtr: false, permError: null, issues: [] };
  return { ...base, mode: 'scan', scanned: COMMON_DKIM_SELECTORS.length, foundCount: 0, failedCount: 0, selectors: [] };
}

/** The resolver's answer when a check used up its DoH budget (resolver.ts). */
const BUDGET_ERROR = 'too many DNS queries for one check';

/**
 * True only when every check finished: no lookup failed, none was cut short (`complete: false`, the deadline, the DoH budget) and the
 * existence lookup answered. Only such a report is stored; anything less is a partial answer that would stay public for good.
 */
export function isComplete(r: PublicReportV1, existenceAnswered: boolean): boolean {
  if (!existenceAnswered) return false;
  for (const c of [r.dmarc, r.spf, r.dkim]) {
    if (c.state === 'lookup-failed' || c.complete !== true) return false;
  }
  return !JSON.stringify(r).includes(BUDGET_ERROR);
}

export interface BuiltReport {
  report: PublicReportV1;
  /** isComplete(report): only then may it be stored. */
  complete: boolean;
}

export async function buildReport(domain: string, source: ReportTool, now: Date = new Date(), deadlineMs = REPORT_DEADLINE_MS): Promise<BuiltReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
  const settle = <T>(run: Promise<T>, fallback: () => T): Promise<T> =>
    Promise.race([run.catch(() => fallback()), deadline.then(fallback)]);

  const [dmarc, spf, dkim, exists] = await Promise.all([
    settle(checkDmarc(domain), () => timedOut('dmarc', domain) as DmarcResult),
    settle(checkSpf(domain), () => timedOut('spf', domain) as SpfResult),
    settle(checkDkim(domain), () => timedOut('dkim', domain) as DkimResult),
    settle(domainExists(domain), () => null),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  const checkedAt = now.toISOString();
  // As in the website's API: `domainExists: false` only on a clear NXDOMAIN for the name itself.
  const missing = exists === false ? { domainExists: false as const } : {};
  // DNS text is the domain owner's, so possibly hostile: no control or bidi character is stored as such (text.ts).
  const report: PublicReportV1 = inertDeep({
    v: 1 as const,
    domain,
    checkedAt,
    source,
    dmarc: { ...dmarc, ...missing, tool: 'dmarc' as const, checkedAt },
    spf: { ...spf, ...missing, tool: 'spf' as const, checkedAt },
    dkim: { ...dkim, ...missing, tool: 'dkim' as const, checkedAt },
  });
  return { report, complete: isComplete(report, exists !== null) };
}
