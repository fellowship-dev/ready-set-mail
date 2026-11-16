// Enforce readiness (RFC 8461 §5: start in testing, read the TLS reports, enforce only when they show senders could use TLS to every MX).
// Pure: the caller reads the config, the reports and the live MX list. A refusal names every failed rule in plain words.

import { isIpLiteral, mxMatchesPattern } from '@ready-set-mail/dns-checks';
import type { MtaStsRow } from '@ready-set-mail/db';
import { ENFORCE_AFTER_SECONDS, EVIDENCE_WINDOW_SECONDS, MAX_AGE_ENFORCE } from './config';

/** RFC 8460 §4.3 failure types that mean a sender could not use TLS (or the policy) as the policy asks. */
export const BLOCKING_FAILURE_TYPES: readonly string[] = [
  'certificate-host-mismatch', 'certificate-expired', 'certificate-not-trusted', 'starttls-not-supported',
  'validation-failure', 'sts-policy-fetch-error', 'sts-policy-invalid', 'sts-webpki-invalid',
];

export interface EvidenceRow { date_begin: number; date_end: number; sts_success: number | null; sts_failure: number | null; sts_failure_types: string | null; reporter_tier: string | null }

/**
 * The evidence rule, in one sentence (shown on the page and decided in ADR 0026): ONE counted report is enough. A counted report is authenticated (a valid DKIM
 * signature by the reporting domain, RFC 8460 section 3) and from a known reporter (src/dmarc/known-reporters.ts: today Google or Microsoft), so it can only be
 * forged by forging that reporter's signature; a second reporter would add coverage, not authenticity, and requiring both would lock out the many small domains
 * that receive mail from only one of them.
 */
export const NO_REPORTS_NOTE = 'A domain that receives no TLS reports can never switch to enforce.';

/** "Google or Microsoft", "Google, Microsoft or Acme": the senders whose signed TLS reports count (the registry's TLS identities, operator additions included). */
export const senderNames = (labels: readonly string[]): string => (labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`);

export const evidenceRule = (labels: readonly string[]): string =>
  `Enforce needs one TLS report signed by ${senderNames(labels)} about the current policy, with successful sessions and no failure that would block mail in the last 14 days.`;

/** One line of the enforce rule: what is needed, whether it is met now, and why not (the same sentences as `reasons`). */
export interface EnforceCheck { key: 'days' | 'report' | 'failures' | 'mx' | 'served'; label: string; met: boolean; reasons: string[] }
export interface Readiness { ready: boolean; reasons: string[]; checks: EnforceCheck[] }

export const splitHosts = (csv: string | null | undefined): string[] => (csv ?? '').split(',').map((h) => h.trim()).filter(Boolean);

const parseTypes = (raw: string | null): string[] => {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []; } catch { return []; }
};

const days = (s: number) => Math.round(s / 86400);

/**
 * May this domain switch to enforce now? All of:
 *  - setup is finished (policy host active, records verified);
 *  - it has been in testing for at least ENFORCE_AFTER_SECONDS;
 *  - at least one COUNTED report (authenticated, from a known reporter: `reporter_tier = 'counted'`, whatever REPORT_COUNTING says: this decides whether mail
 *    is refused, so a stranger must never move it) whose period ended after the current policy id was published, with successful MTA-STS sessions;
 *  - no failure of a blocking type in the counted reports of the last EVIDENCE_WINDOW_SECONDS that ended after that publication;
 *  - every MX host is a hostname (not an address) and matches the policy's mx list (`liveMx` is today's MX list, null when it could not be read).
 */
export function enforceReadiness(cfg: Pick<MtaStsRow, 'state' | 'mode' | 'mx_hosts' | 'policy_published_at' | 'mode_changed_at'> & { fetch_ok?: number | null }, allReports: readonly EvidenceRow[], liveMx: readonly string[] | null, now: number, opts: { verifiable?: boolean; reporters?: readonly string[] } = {}): Readiness {
  const reports = allReports.filter((r) => r.reporter_tier === 'counted');
  const served: string[] = [], days_: string[] = [], report: string[] = [], failures: string[] = [], mx: string[] = [];
  const checks = (): EnforceCheck[] => [
    { key: 'days', label: `${days(ENFORCE_AFTER_SECONDS)} days in testing`, met: !days_.length, reasons: days_ },
    { key: 'report', label: `A report signed by ${senderNames(opts.reporters ?? ['Google', 'Microsoft'])} about this policy, with successful sessions`, met: !report.length, reasons: report },
    { key: 'failures', label: `No failures in signed reports in the last ${days(EVIDENCE_WINDOW_SECONDS)} days`, met: !failures.length, reasons: failures },
    { key: 'mx', label: 'The MX hosts match the policy', met: !mx.length, reasons: mx },
    { key: 'served', label: 'The policy is served', met: !served.length, reasons: served },
  ];
  if (cfg.mode === 'enforce') return { ready: false, reasons: ['It is already enforcing.'], checks: checks() };
  if (cfg.state !== 'active') served.push('Setup is not finished.');
  else if (cfg.fetch_ok === 0) served.push('The policy cannot be reached right now.');

  const inTesting = cfg.mode_changed_at ? now - cfg.mode_changed_at : 0;
  if (inTesting < ENFORCE_AFTER_SECONDS) {
    const left = Math.max(1, Math.ceil((ENFORCE_AFTER_SECONDS - inTesting) / 86400));
    days_.push(`In testing for ${Math.floor(inTesting / 86400)} of ${days(ENFORCE_AFTER_SECONDS)} days: ${left} more.`);
  }

  const published = cfg.policy_published_at;
  const since = Math.max(now - EVIDENCE_WINDOW_SECONDS, published ?? 0);
  if (published === null) report.push('The policy id is not published yet.');
  else if (!reports.some((r) => r.date_end > published && (r.sts_success ?? 0) > 0)) {
    // Say which of the three it is: nothing verified at all, only a period from before this policy, or a period since without a successful session.
    report.push(opts.verifiable === false
      ? 'This server cannot tell who sent a report (AUTHSERV_ID and AUTHSERV_HEADER are not set), so none counts.'
      : reports.length === 0 ? 'No verified TLS report has arrived yet for this policy.'
      : reports.every((r) => r.date_end <= published) ? 'A verified report arrived, but it covers a period before this policy was published.'
      : 'A verified report arrived for this policy, but it shows no successful session.');
  }
  const failed = new Set<string>();
  let unexplained = 0;
  for (const r of reports) {
    if (published === null || r.date_end < since || r.date_end <= published) continue;
    const blocking = parseTypes(r.sts_failure_types).filter((t) => BLOCKING_FAILURE_TYPES.includes(t));
    blocking.forEach((t) => failed.add(t));
    if ((r.sts_failure ?? 0) > 0 && blocking.length === 0 && parseTypes(r.sts_failure_types).length === 0) unexplained++;
  }
  if (failed.size) failures.push(`TLS failures in the last ${days(EVIDENCE_WINDOW_SECONDS)} days: ${[...failed].sort().join(', ')}.`);
  if (unexplained) failures.push(`${unexplained} ${unexplained === 1 ? 'report counts' : 'reports count'} failed sessions without saying why.`);

  const stored = splitHosts(cfg.mx_hosts);
  const ips = stored.filter(isIpLiteral);
  if (ips.length) mx.push(`MX ${ips.length === 1 ? 'host' : 'hosts'} ${ips.join(', ')} ${ips.length === 1 ? 'is an address' : 'are addresses'}: a certificate cannot match an address, so senders would refuse mail.`);
  if (liveMx === null) mx.push('The MX hosts could not be read just now; try again in a moment.');
  else if (liveMx.length === 0) mx.push('The domain has no MX records.');
  else {
    const loose = liveMx.filter((h) => !stored.some((p) => mxMatchesPattern(h, p)));
    if (loose.length) mx.push(`MX ${loose.length === 1 ? 'host' : 'hosts'} ${loose.join(', ')} ${loose.length === 1 ? 'is' : 'are'} not in the published policy yet: refresh the MX hosts and wait for new reports.`);
    const liveIps = liveMx.filter(isIpLiteral);
    if (liveIps.length && !ips.length) mx.push(`MX ${liveIps.join(', ')} ${liveIps.length === 1 ? 'is an address' : 'are addresses'}, not a hostname.`);
  }
  const all = checks();
  // The order of `reasons` is the order the rule has always listed them in: setup, days, report, failures, MX.
  const reasons = [...served, ...days_, ...report, ...failures, ...mx];
  return { ready: reasons.length === 0, reasons, checks: all };
}

/**
 * Disable rule (ADR 0026): only in testing, and only once senders that fetched an ENFORCE policy no longer hold it: its max_age (MAX_AGE_ENFORCE, a week) after
 * the switch back. The testing policy's own max_age is shorter and says nothing about what senders still hold from before (RFC 8461 section 8.3: "the previously
 * published policy was last served plus that policy's max_age").
 */
export function disableRule(cfg: Pick<MtaStsRow, 'mode' | 'left_enforce_at'>, now: number): { allowed: boolean; after: number | null; reason: string | null } {
  if (cfg.mode === 'enforce') {
    return { allowed: false, after: null, reason: `Switch to testing first. Senders keep the enforce policy for up to ${maxAgeWords(MAX_AGE_ENFORCE)}; you can disable it after that.` };
  }
  const after = cfg.left_enforce_at ? cfg.left_enforce_at + MAX_AGE_ENFORCE : null;
  if (after !== null && now < after) {
    return { allowed: false, after, reason: `Senders keep the enforce policy for up to ${maxAgeWords(MAX_AGE_ENFORCE)}. You can disable MTA-STS after ${new Date(after * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.` };
  }
  return { allowed: true, after: null, reason: null };
}

export function maxAgeWords(seconds: number): string {
  if (seconds % 86400 === 0) { const d = seconds / 86400; return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (seconds % 3600 === 0) { const h = seconds / 3600; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  return `${seconds} seconds`;
}
