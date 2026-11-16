// The DMARC policy in force for ONE name, and where it comes from. The one place a level, a grade or a verdict for a
// name takes its policy from (the public checker, the agent report, the stored facts): none of them reads `p=` of a
// record found at another name.
//
// RFC 9989 section 4.10.1: the record found at the name itself sets its policy with `p=` (`sp=` and `np=` are ignored on a
// record published at a subdomain, section 4.7). A name with no record of its own takes the organizational domain's record,
// and from it `sp=` when the name exists, `np=` when it does not exist (NXDOMAIN, section 3.2.13), and `p=` when the
// applicable tag is absent. Section 4.7 `np=`: absent, the `sp=` policy applies, and without `sp=` the `p=` policy.
// A record whose `sp=` is not valid is applied as p=none when it has a valid rua= (section 4.10.1, `dmarcBreakOf`).
//
// Pure and dependency-free (no resolver, no PSL), so the dashboard can import this file alone.

import type { Policy as DmarcPolicy } from './dmarc-next-step';
import { dmarcBreakOf, hasValidRua } from './dmarc-problem';
import { parseDmarcTags } from './dmarc-tags';

/** The tag that sets the policy: `p`, `sp` (existing subdomain of the record's domain) or `np` (a name that does not exist). */
export type PolicyTag = 'p' | 'sp' | 'np';

export interface EffectivePolicy {
  /**
   * `applies`: a policy is in force. `none`: no record covers the name. `multiple`: several records, DMARC does not apply.
   * `broken`: a record exists whose p= or sp= is not valid (`policy` is what receivers apply instead). `error`: DNS failed, nothing is known.
   */
  status: 'applies' | 'none' | 'multiple' | 'broken' | 'error';
  /** What receivers apply to mail from this name; null when none does (no record, several, a broken record without a valid rua=, a DNS error). */
  policy: DmarcPolicy | null;
  /** The tag that sets it (null when `policy` is null). */
  tag: PolicyTag | null;
  /** For `broken`: the tag whose value is not valid (`p`, `sp` or `np`), so a caller can name it. Null otherwise. */
  invalidTag: PolicyTag | null;
  /** The domain whose `_dmarc` record sets it (the name itself, or its organizational domain); null when no record. */
  at: string | null;
  /** The record is the name's own (`own`) or its organizational domain's (`organizational`). */
  source: 'own' | 'organizational' | null;
  /** The name exists in DNS (false: NXDOMAIN); null when not known. Only the organizational domain's `np=` depends on it. */
  exists: boolean | null;
}

const POLICIES: ReadonlySet<string> = new Set(['none', 'quarantine', 'reject']);
const asPolicy = (v: string | undefined): DmarcPolicy | null => {
  const l = v?.trim().toLowerCase();
  return l && POLICIES.has(l) ? (l as DmarcPolicy) : null;
};

/** The parts of a DMARC discovery result (`DmarcLookup` in ./dmarc) the policy rule reads. */
export interface DiscoveredDmarc {
  status: 'found' | 'none' | 'multiple' | 'error';
  domain: string;
  inherited: boolean;
  foundAt: string | null;
  record: { raw: string; policy: DmarcPolicy } | null;
}

/** True when the governing record is the organizational domain's and carries a valid np=: the only case existence changes the answer. */
export function existenceMatters(l: Pick<DiscoveredDmarc, 'status' | 'inherited' | 'record'>): boolean {
  return l.status === 'found' && l.inherited && !!l.record && asPolicy(parseDmarcTags(l.record.raw)['np']) !== null;
}

/**
 * The policy in force for `l.domain`, from its DMARC discovery result. `exists`: whether the name exists in DNS (false: NXDOMAIN),
 * null when unknown. An unknown existence is read as "exists" (`sp=` applies), and `exists` stays null so a caller can say so.
 */
export function effectivePolicy(l: DiscoveredDmarc, exists: boolean | null = null, opts: { invalidNp?: 'apply' | 'ignore' } = {}): EffectivePolicy {
  const none = { policy: null, tag: null, at: null, source: null, exists, invalidTag: null } as const;
  if (l.status === 'error') return { status: 'error', ...none };
  if (l.status === 'none') return { status: 'none', ...none };
  const at = l.foundAt?.replace(/^_dmarc\./, '') ?? null;
  const source = l.inherited ? 'organizational' : 'own';
  if (l.status === 'multiple' || !l.record) return { status: 'multiple', ...none, at, source };
  const broken = dmarcBreakOf(l.record.raw);
  if (broken) {
    // The record is not applied as written: p=none when it has a valid rua=, no DMARC at all otherwise (section 4.10.1).
    const tag = broken.issue === 'invalid_sp' ? 'sp' : 'p';
    return { status: 'broken', policy: broken.appliedAs, tag: broken.appliedAs ? tag : null, invalidTag: tag, at, source, exists };
  }
  const tags = parseDmarcTags(l.record.raw);
  // An np= that is not a policy breaks the record the same way an invalid sp= does (section 4.10.1). The dashboard's stored facts have no
  // issue kind for it (`dmarcFactsFromLookup` passes 'ignore'), so there it is read as absent.
  if (tags['np'] !== undefined && asPolicy(tags['np']) === null && opts.invalidNp !== 'ignore') {
    const appliedAs = hasValidRua(tags['rua']) ? 'none' : null;
    return { status: 'broken', policy: appliedAs, tag: appliedAs ? 'np' : null, invalidTag: 'np', at, source, exists };
  }
  const p = l.record.policy;
  if (!l.inherited) return { status: 'applies', policy: p, tag: 'p', invalidTag: null, at, source, exists };
  const sp = asPolicy(tags['sp']);
  const np = asPolicy(tags['np']);
  if (exists === false && np) return { status: 'applies', policy: np, tag: 'np', invalidTag: null, at, source, exists };
  if (sp) return { status: 'applies', policy: sp, tag: 'sp', invalidTag: null, at, source, exists };
  return { status: 'applies', policy: p, tag: 'p', invalidTag: null, at, source, exists };
}

/** One sentence: which record and tag set the name's policy (the public checker and the agent report say it the same way). */
export function effectivePolicySentence(name: string, e: EffectivePolicy): string | null {
  if (e.status === 'broken' && e.invalidTag && e.at) {
    const what = e.policy ? 'act as if it said p=none' : 'ignore it, because it has no valid rua=';
    return `The DMARC record at _dmarc.${e.at} has an invalid ${e.invalidTag}= value, so receivers ${what} (RFC 9989 section 4.10.1).`;
  }
  if (!e.policy || !e.tag || !e.at) return null;
  if (e.source === 'own') return `${name} publishes its own DMARC record, which sets p=${e.policy}.`;
  const org = e.at;
  if (e.tag === 'np') return `${name} does not exist in DNS and has no DMARC record of its own, so np=${e.policy} on ${org}'s record applies to it.`;
  if (e.tag === 'sp') return `${name} has no DMARC record of its own, so sp=${e.policy} on ${org}'s record applies to it (that record's p= applies to ${org} itself).`;
  return `${name} has no DMARC record of its own, so p=${e.policy} on ${org}'s record applies to it (that record has no sp=${e.exists === false ? ' or np=' : ''} tag that applies).`;
}
