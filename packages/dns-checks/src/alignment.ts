// DMARC identifier alignment: whether the domain SPF or DKIM authenticated is "the same" as the From domain, and, for a message
// that failed DMARC, which identifier failed to align and why. ONE place for it: the sender inventory (src/analytics/senders.ts),
// the failing-source lists and the dashboard's explanations all call these.
//
// RFC 9989 section 3.2.10.1 (relaxed): the two domains have the same organizational domain. Section 3.2.10.2 (strict): they are
// identical. The SPF identifier is the MAIL FROM (return-path) domain, never the From domain (section 3.2.4, RFC 7208 section 3);
// the DKIM identifier is the signature's d= (RFC 6376 section 3.5). A report lists both per record (RFC 9990 section 3.1.1.10-13);
// the receiver's own aligned verdict is `policy_evaluated`, which `report_records.spf_aligned/dkim_aligned` keep.
//
// Pure apart from the public-suffix lookup (./org-domain), so the dashboard can import this file.

import { organizationalDomain, sameOrganizationalDomain } from './org-domain';

export type AlignMode = 'r' | 's';
export interface AlignModes { spf: AlignMode; dkim: AlignMode }
export const RELAXED: AlignModes = { spf: 'r', dkim: 'r' };

const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');

/** Do the two domains align? Relaxed: same organizational domain. Strict: the same domain. */
export function aligned(a: string | null | undefined, b: string | null | undefined, mode: AlignMode = 'r'): boolean {
  if (!a || !b) return false;
  if (mode === 's') return norm(a) === norm(b);
  return sameOrganizationalDomain(a, b);
}

export type AlignmentWhy =
  /** the identifier passed and aligns */
  | 'aligned'
  /** the receiver reported no passing result for this identifier */
  | 'not-passed'
  /** a result without a domain, or no result at all */
  | 'no-identifier'
  /** passed, same organizational domain, but the record says strict and the names differ */
  | 'strict-differs'
  /** passed for a domain of another organization */
  | 'other-organization';

export interface IdentifierAlignment {
  kind: 'spf' | 'dkim';
  /** The SPF domain (MAIL FROM) or the DKIM d= the receiver reported; null when none. */
  domain: string | null;
  passed: boolean;
  aligned: boolean;
  mode: AlignMode;
  why: AlignmentWhy;
}

/** One identifier of one record against the From domain, under the record's mode for it. */
export function identifierAlignment(kind: 'spf' | 'dkim', domain: string | null | undefined, passed: boolean, from: string | null | undefined, mode: AlignMode = 'r'): IdentifierAlignment {
  const d = domain?.trim() ? norm(domain) : null;
  const base = { kind, domain: d, passed, mode };
  if (!passed) return { ...base, aligned: false, why: d ? 'not-passed' : 'no-identifier' };
  if (!d) return { ...base, aligned: false, why: 'no-identifier' };
  if (aligned(d, from, mode)) return { ...base, aligned: true, why: 'aligned' };
  return { ...base, aligned: false, why: mode === 's' && aligned(d, from, 'r') ? 'strict-differs' : 'other-organization' };
}

/** The stored facts of one report record (or a group of them) that alignment reads. */
export interface AlignmentInput {
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  /** 1 when the record's raw SPF / DKIM result was pass. */
  spf_pass: number | boolean;
  dkim_pass: number | boolean;
  /** The receiver's own verdict (policy_evaluated): 1 aligned, 0 not, null/undefined: stored before it was kept. */
  spf_aligned?: number | null;
  dkim_aligned?: number | null;
}

/**
 * The receiver's DMARC verdict for one stored record, from `policy_evaluated` (RFC 9990 section 3.1.1.9: "the result of the DKIM/SPF DMARC
 * Identifier Alignment test"). RFC 9989 section 5.3.5: a message passes DMARC when SPF OR DKIM passes AND aligns, so one is enough.
 *   failed        neither aligned
 *   passed        both aligned
 *   passed-one    exactly one aligned (DMARC passed, but with no backup)
 *   not-recorded  stored before 0017 kept the verdict (NULL), or not recoverable by the backfill (-1), or only one of the two known
 * ONE rule: the SQL twin is `verdictSql` (packages/db/src/queries/verdict.ts), tested against this function for every combination.
 */
export type DmarcVerdict = 'failed' | 'passed' | 'passed-one' | 'not-recorded';

export function dmarcVerdict(r: { spf_aligned?: number | null; dkim_aligned?: number | null }): DmarcVerdict {
  const s = r.spf_aligned ?? null;
  const d = r.dkim_aligned ?? null;
  if (s === 0 && d === 0) return 'failed';
  if (s === 1 && d === 1) return 'passed';
  if (s === 1 || d === 1) return 'passed-one';
  return 'not-recorded';
}

export interface AlignmentVerdict {
  /** DMARC failed for this record: the receiver's verdict says neither identifier aligned. An unknown verdict is never "failed". */
  dmarcFailed: boolean;
  spf: IdentifierAlignment;
  dkim: IdentifierAlignment;
}

/**
 * Which identifier failed alignment. The receiver's verdict (`spf_aligned`/`dkim_aligned`) decides whether DMARC failed when it
 * was kept; the domains and the mode then say why. A record stored without it is never called failed (`dmarcVerdict`).
 */
export function alignmentVerdict(r: AlignmentInput, modes: AlignModes = RELAXED): AlignmentVerdict {
  const spf = identifierAlignment('spf', r.spf_domain, !!r.spf_pass, r.header_from, modes.spf);
  const dkim = identifierAlignment('dkim', r.dkim_domain, !!r.dkim_pass, r.header_from, modes.dkim);
  const dmarcFailed = dmarcVerdict(r) === 'failed';
  return { dmarcFailed, spf, dkim };
}

const modeWord = (m: AlignMode) => (m === 's' ? 'strict' : 'relaxed');

/** One sentence: what the identifier was and why it does not align (empty when it aligns). */
export function whyNotAligned(a: IdentifierAlignment, from: string | null | undefined): string {
  const what = a.kind === 'spf' ? 'SPF' : 'DKIM';
  const id = a.kind === 'spf' ? `the return-path (MAIL FROM) domain ${a.domain}` : `the signing domain d=${a.domain}`;
  const fromName = from || 'the From domain';
  switch (a.why) {
    case 'aligned': return '';
    case 'no-identifier': return `${what} gave no ${a.kind === 'spf' ? 'return-path domain' : 'signing domain'} to compare with ${fromName}.`;
    case 'not-passed': return `${what} did not pass for ${id}.`;
    case 'strict-differs': return `${what} passed for ${id}, but the record asks for strict alignment (${a.kind === 'spf' ? 'aspf=s' : 'adkim=s'}), which needs the identical domain ${fromName}.`;
    case 'other-organization': return `${what} passed for ${id}, which is not in the same organization as ${fromName}, so under ${modeWord(a.mode)} alignment it does not count for DMARC.`;
  }
}

/**
 * What to change so this identifier aligns, at the exact name or in the sending service's own settings. Never "add the
 * service's bounce hostname to your SPF record": SPF is checked at the return-path domain, not at the From domain, so a record
 * at the From name cannot make a different return-path domain align (RFC 7208 section 3, RFC 9989 section 3.2.4).
 */
export function alignmentFix(a: IdentifierAlignment, from: string | null | undefined): string {
  const f = from || 'your domain';
  const org = (from && organizationalDomain(from)) || f;
  if (a.aligned) return '';
  if (a.kind === 'spf') {
    if (a.why === 'strict-differs') return `Either change aspf=s to aspf=r (or remove it) in the DMARC record that applies to ${f}, or make DKIM align (DKIM alone is enough for DMARC).`;
    if (a.why === 'other-organization') return `In the sending service's settings, set a custom return-path (MAIL FROM) domain under ${org}, and publish the DNS records the service lists for it. Adding ${a.domain} to the SPF record at ${f} would not help: SPF is checked at ${a.domain}, not at ${f}. DKIM aligned with ${f} is the alternative.`;
    return `Authorize the sending server in the SPF record of its return-path domain, or sign with DKIM as ${f}.`;
  }
  if (a.why === 'strict-differs') return `Either change adkim=s to adkim=r (or remove it) in the DMARC record that applies to ${f}, or have the service sign with d=${f}.`;
  if (a.why === 'other-organization') return `In the sending service's settings, turn on domain authentication so it signs with a d= under ${org}, and publish the DKIM key records it lists, at the names it shows (<selector>._domainkey.<the d= it signs with>).`;
  return `Turn on DKIM signing for ${f} in the sending service and publish its key records.`;
}

/**
 * The attribution of one DMARC-failed record: the identifiers, in words, with the fix for each that did not align. Empty `lines`
 * for a record that passed DMARC.
 */
export function explainAlignment(r: AlignmentInput, modes: AlignModes = RELAXED): { dmarcFailed: boolean; lines: { sentence: string; fix: string }[] } {
  const v = alignmentVerdict(r, modes);
  if (!v.dmarcFailed) return { dmarcFailed: false, lines: [] };
  const lines = [v.spf, v.dkim].filter((a) => a.why !== 'aligned').map((a) => ({ sentence: whyNotAligned(a, r.header_from), fix: alignmentFix(a, r.header_from) }));
  return { dmarcFailed: true, lines };
}
