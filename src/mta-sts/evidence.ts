// Enforce readiness (RFC 8461 §5: start in testing, read the TLS reports, enforce only when they show senders could use TLS to every MX).
// Pure: the caller reads the config, the reports and the live MX list. A refusal names every failed rule in plain words.

import { isIpLiteral, mxMatchesPattern } from '@ready-set-mail/dns-checks';
import type { MtaStsRow } from '@ready-set-mail/db';
import { ENFORCE_AFTER_SECONDS, EVIDENCE_WINDOW_SECONDS } from './config';

/** RFC 8460 §4.3 failure types that mean a sender could not use TLS (or the policy) as the policy asks. */
export const BLOCKING_FAILURE_TYPES: readonly string[] = [
  'certificate-host-mismatch', 'certificate-expired', 'certificate-not-trusted', 'starttls-not-supported',
  'validation-failure', 'sts-policy-fetch-error', 'sts-policy-invalid', 'sts-webpki-invalid',
];

export interface EvidenceRow { date_begin: number; date_end: number; sts_success: number | null; sts_failure: number | null; sts_failure_types: string | null }

export interface Readiness { ready: boolean; reasons: string[] }

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
 *  - at least one report whose period ended after the current policy id was published, with successful MTA-STS sessions;
 *  - no failure of a blocking type in the reports of the last EVIDENCE_WINDOW_SECONDS that ended after that publication;
 *  - every MX host is a hostname (not an address) and matches the policy's mx list (`liveMx` is today's MX list, null when it could not be read).
 */
export function enforceReadiness(cfg: Pick<MtaStsRow, 'state' | 'mode' | 'mx_hosts' | 'policy_published_at' | 'mode_changed_at'>, reports: readonly EvidenceRow[], liveMx: readonly string[] | null, now: number): Readiness {
  const reasons: string[] = [];
  if (cfg.mode === 'enforce') return { ready: false, reasons: ['It is already enforcing.'] };
  if (cfg.state !== 'active') reasons.push('Setup is not finished: the policy host or one of the DNS records is not confirmed yet.');

  const inTesting = cfg.mode_changed_at ? now - cfg.mode_changed_at : 0;
  if (inTesting < ENFORCE_AFTER_SECONDS) {
    const left = Math.max(1, Math.ceil((ENFORCE_AFTER_SECONDS - inTesting) / 86400));
    reasons.push(`It has been in testing for ${Math.floor(inTesting / 86400)} of the ${days(ENFORCE_AFTER_SECONDS)} days senders need to report: ${left} more ${left === 1 ? 'day' : 'days'}.`);
  }

  const published = cfg.policy_published_at;
  const since = Math.max(now - EVIDENCE_WINDOW_SECONDS, published ?? 0);
  if (published === null) reasons.push('The current policy id is not published in DNS yet, so no report can be about it.');
  else if (!reports.some((r) => r.date_end > published && (r.sts_success ?? 0) > 0)) {
    reasons.push('No TLS report has arrived yet for the current policy with successful sessions: senders have not shown they can deliver with TLS.');
  }
  const failed = new Set<string>();
  let unexplained = 0;
  for (const r of reports) {
    if (published === null || r.date_end < since || r.date_end <= published) continue;
    const blocking = parseTypes(r.sts_failure_types).filter((t) => BLOCKING_FAILURE_TYPES.includes(t));
    blocking.forEach((t) => failed.add(t));
    if ((r.sts_failure ?? 0) > 0 && blocking.length === 0 && parseTypes(r.sts_failure_types).length === 0) unexplained++;
  }
  if (failed.size) reasons.push(`Senders reported TLS failures in the last ${days(EVIDENCE_WINDOW_SECONDS)} days: ${[...failed].sort().join(', ')}.`);
  if (unexplained) reasons.push(`${unexplained} ${unexplained === 1 ? 'report counts' : 'reports count'} failed sessions without saying why.`);

  const stored = splitHosts(cfg.mx_hosts);
  const ips = stored.filter(isIpLiteral);
  if (ips.length) reasons.push(`MX ${ips.length === 1 ? 'host' : 'hosts'} ${ips.join(', ')} ${ips.length === 1 ? 'is an address' : 'are addresses'}: a certificate cannot match an address, so senders would refuse mail.`);
  if (liveMx === null) reasons.push('The MX hosts could not be read just now; try again in a moment.');
  else if (liveMx.length === 0) reasons.push('The domain has no MX records.');
  else {
    const loose = liveMx.filter((h) => !stored.some((p) => mxMatchesPattern(h, p)));
    if (loose.length) reasons.push(`MX ${loose.length === 1 ? 'host' : 'hosts'} ${loose.join(', ')} ${loose.length === 1 ? 'is' : 'are'} not in the published policy yet: refresh the MX hosts and wait for new reports.`);
    const liveIps = liveMx.filter(isIpLiteral);
    if (liveIps.length && !ips.length) reasons.push(`MX ${liveIps.join(', ')} ${liveIps.length === 1 ? 'is an address' : 'are addresses'}, not a hostname.`);
  }
  return { ready: reasons.length === 0, reasons };
}

/** Disable rule (ADR 0021): only in testing, and only once senders that fetched an enforce policy no longer hold it. */
export function disableRule(cfg: Pick<MtaStsRow, 'mode' | 'left_enforce_at' | 'max_age'>, now: number): { allowed: boolean; after: number | null; reason: string | null } {
  if (cfg.mode === 'enforce') {
    return { allowed: false, after: null, reason: `Switch to testing first. Senders keep the enforce policy for up to ${maxAgeWords(cfg.max_age)}; you can disable it after that.` };
  }
  const after = cfg.left_enforce_at ? cfg.left_enforce_at + cfg.max_age : null;
  if (after !== null && now < after) {
    return { allowed: false, after, reason: `Senders keep the enforce policy for up to ${maxAgeWords(cfg.max_age)}. You can disable MTA-STS after ${new Date(after * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.` };
  }
  return { allowed: true, after: null, reason: null };
}

export function maxAgeWords(seconds: number): string {
  if (seconds % 86400 === 0) { const d = seconds / 86400; return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (seconds % 3600 === 0) { const h = seconds / 3600; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  return `${seconds} seconds`;
}
