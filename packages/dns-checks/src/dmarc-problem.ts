// What is wrong with a published DMARC record as receivers apply it, in one plain sentence. ONE place for it: the stored
// facts (src/email/dns-snapshot.ts), every dashboard surface (overview, domain page, DNS records, wizards, PDF) and the
// agent tools say the same thing, from the live record or from what was stored about it.
//
// RFC 7489 section 6.6.3 (step 6): a record whose p= is missing or not valid, or whose sp= is not valid, is not applied as
// written. With at least one syntactically valid rua= URI receivers act as if it said p=none; without one they apply no
// DMARC at all.
//
// Pure and dependency-free apart from the tag parser, so the dashboard can import this file alone.

import { parseDmarcTags } from './dmarc-tags';

/** Why a DMARC record gives receivers no policy as written: several records at the name, no valid p=, or an invalid sp=. */
export type DmarcIssue = 'multiple' | 'invalid' | 'invalid_sp';

export interface DmarcBreak {
  /** `invalid`: p= is missing or not none/quarantine/reject. `invalid_sp`: p= is valid, sp= is present and not valid. */
  issue: 'invalid' | 'invalid_sp';
  /** What receivers do instead: `none`, they act as if the record said p=none (it has a valid rua=); null, they apply no DMARC. */
  appliedAs: 'none' | null;
  /** The sp= value as written (`invalid_sp`), else null. */
  sp: string | null;
}

const POLICIES: ReadonlySet<string> = new Set(['none', 'quarantine', 'reject']);
const isPolicy = (v: string | undefined) => v !== undefined && POLICIES.has(v.trim().toLowerCase());

/** At least one syntactically valid rua= URI (RFC 7489 section 6.6.3, step 6.1). */
export function hasValidRua(rua: string | undefined): boolean {
  return (rua ?? '').split(',').some((u) => /^mailto:[^\s@]+@[^\s@]+/i.test(u.trim()));
}

/** How a single v=DMARC1 record is broken as published, or null when its p= and sp= are both valid. */
export function dmarcBreakOf(record: string | null | undefined): DmarcBreak | null {
  const tags = parseDmarcTags(record);
  const appliedAs = hasValidRua(tags['rua']) ? 'none' : null;
  if (!isPolicy(tags['p'])) return { issue: 'invalid', appliedAs, sp: null };
  if (tags['sp'] !== undefined && !isPolicy(tags['sp'])) return { issue: 'invalid_sp', appliedAs, sp: tags['sp'] };
  return null;
}

/** True for the stored issues that mean "a record exists, but receivers get no policy from it as written". */
export function isDmarcIssue(issue: string | null | undefined): issue is DmarcIssue {
  return issue === 'multiple' || issue === 'invalid' || issue === 'invalid_sp';
}

/**
 * The sentence for a broken record at `at` (`_dmarc.<domain>`): what receivers do, then the fix. `appliedAs` undefined
 * (not known) is read as "no DMARC", the RFC's outcome without a valid rua=.
 */
export function dmarcBreakSentence(at: string, b: { issue: DmarcIssue; appliedAs?: 'none' | null; sp?: string | null }): string {
  if (b.issue === 'multiple') return `There are several DMARC records at ${at}, so receivers ignore all of them. Keep one and delete the others.`;
  const asNone = b.appliedAs === 'none';
  if (b.issue === 'invalid_sp') {
    const sp = `sp=${b.sp ?? ''}`;
    return asNone
      ? `At ${at}, ${sp} is not a valid policy, so receivers treat the whole record as p=none. Fix sp= or remove it.`
      : `At ${at}, ${sp} is not a valid policy and the record has no valid rua=, so receivers ignore the whole record. Fix sp= or remove it.`;
  }
  return asNone
    ? `At ${at}, the DMARC record has no valid p= policy (none, quarantine or reject), so receivers treat the whole record as p=none. Set p= to none, quarantine or reject.`
    : `At ${at}, the DMARC record has no valid p= policy (none, quarantine or reject) and no valid rua=, so receivers ignore it. Set p= to none, quarantine or reject.`;
}

/** The fix alone, as a verb, for a step title. */
export function dmarcBreakFix(at: string, issue: DmarcIssue): string {
  if (issue === 'multiple') return `Keep one DMARC record at ${at} and delete the others`;
  if (issue === 'invalid_sp') return `Fix sp= at ${at}`;
  return `Fix the DMARC record at ${at} so it has a valid p= policy`;
}

/** A short label for badges and table cells. */
export function dmarcBreakLabel(issue: DmarcIssue): string {
  if (issue === 'multiple') return 'Multiple DMARC records';
  if (issue === 'invalid_sp') return 'DMARC record has an invalid sp=';
  return 'DMARC record is invalid';
}

/**
 * What is wrong with a DMARC record as receivers apply it, in one plain sentence, or null when nothing is: several records
 * at the name (`issue` 'multiple' from the stored read), a TXT that is not DMARC, an invalid p= or an invalid sp=.
 */
export function dmarcRecordProblem(record: string | null | undefined, at: string, issue?: string | null): string | null {
  if (issue === 'multiple') return dmarcBreakSentence(at, { issue: 'multiple' });
  if (!record) return null;
  if (!/^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(record)) return `The TXT record at ${at} is not a DMARC record (it does not start with v=DMARC1), so receivers ignore it.`;
  const b = dmarcBreakOf(record);
  return b ? dmarcBreakSentence(at, b) : null;
}

/** The broken record described by stored facts (`dmarc_issue`, and `dmarc_p`/`dmarc_sp` as stored for it), or null. */
export function storedDmarcBreak(s: { dmarc_issue?: string | null; dmarc_p?: string | null; dmarc_sp?: string | null }): { issue: DmarcIssue; appliedAs: 'none' | null; sp: string | null } | null {
  if (!isDmarcIssue(s.dmarc_issue)) return null;
  return { issue: s.dmarc_issue, appliedAs: s.dmarc_p === 'none' ? 'none' : null, sp: s.dmarc_issue === 'invalid_sp' ? (s.dmarc_sp ?? null) : null };
}
