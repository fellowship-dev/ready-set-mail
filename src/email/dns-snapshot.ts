// What a live DNS read says about a domain's SPF and DMARC, in the shape `domains.recordDnsCheck` stores.
//
// A field is `undefined` when DNS could not answer (failure), `null` when DNS answered "no record", and the value
// otherwise. Unknown is never folded into absent.

import { createResolver, isSpfRecord, lookupDmarc, parseDmarcRecord, ruaEntries, ruaEntryAddress, type DmarcLookup, type Resolver, type TxtResult } from '@ready-set-mail/dns-checks';
import { parseDmarcTags } from '@ready-set-mail/dns-checks/dmarc-tags';
import { effectivePolicy } from '@ready-set-mail/dns-checks/effective-policy';
import { dmarcBreakOf } from '@ready-set-mail/dns-checks/dmarc-problem';
import type { DmarcFacts } from '@ready-set-mail/db';
import { RECORDS_SEPARATOR, lookupSpf } from './dns-check';

/** SPF from the TXT answer at the domain (several v=spf1 records are joined, like lookupSpf does). */
export function spfFromTxt(records: readonly string[]): string | null {
  const spf = records.filter(isSpfRecord).map(r => r.trim());
  return spf.length ? spf.join(RECORDS_SEPARATOR) : null;
}

/**
 * The DMARC policy that applies to the domain, from the package's RFC 7489 discovery (`lookupDmarc`: the domain's own
 * record, else its organizational domain's). The policy is the EFFECTIVE one: an own record's `p=`; an inherited
 * record's `sp=` when it has one, else its `p=`. `undefined`: DNS could not answer, so nothing is known.
 * `null` policy with an `issue`: a record exists but receivers get no policy from it as written: several records
 * (`multiple`), no valid `p=` (`invalid`) or an invalid `sp=` (`invalid_sp`). For the last two the record's tags are stored
 * too, `p` holding what receivers apply instead (RFC 7489 section 6.6.3: 'none' with a valid rua=, null without) and `sp`
 * the invalid value as written, so every page can say exactly what is wrong (packages/dns-checks/src/dmarc-problem.ts).
 */
export function dmarcFactsFromLookup(l: DmarcLookup): DmarcFacts | undefined {
  if (l.status === 'error') return undefined;
  const inherited_from = l.inherited ? l.organizationalDomain : null;
  const none = { pct: null, p: null, sp: null, rua: null };
  if (l.status === 'none') return { policy: null, issue: null, inherited_from: null, ...none };
  if (l.status === 'multiple') return { policy: null, issue: 'multiple', inherited_from, ...none };
  const broken = l.record ? dmarcBreakOf(l.record.raw) : null;
  if (l.record && broken) return { policy: null, issue: broken.issue, inherited_from, ...governingTags(l.record.raw) };
  if (!l.record?.valid) return { policy: null, issue: 'invalid', inherited_from, ...none };
  // The stored facts describe a name that exists (a monitored domain that does not resolve is shown as such before any policy),
  // so `sp=` applies to an inherited name here, never `np=`, and an invalid `np=` is read as absent (the stored facts have no issue kind for it, and a schema change for it is not made); the one rule is `effectivePolicy` (RFC 9989 section 4.10.1).
  return { policy: effectivePolicy(l, true, { invalidNp: 'ignore' }).policy, issue: null, inherited_from, ...governingTags(l.record.raw) };
}

/**
 * pct=, p=, sp= (as written: null without the tag) and the rua= addresses of the governing record, so every page can tell
 * full enforcement from partial, name the exact tag that sets a subdomain's policy, and say whether reports reach us.
 */
export function governingTags(raw: string): Required<Pick<DmarcFacts, 'pct' | 'p' | 'sp' | 'rua'>> {
  const rec = parseDmarcRecord(raw);
  const sp = parseDmarcTags(raw)['sp']?.trim().toLowerCase();
  const broken = dmarcBreakOf(raw);
  return {
    pct: rec.pct,
    // A broken record (no valid p=, or an invalid sp=): p is what receivers apply instead, sp the invalid value as written.
    p: broken ? broken.appliedAs : rec.policy,
    // An invalid sp= is kept as written (`sp=Rejectt`), so every page names the same value the DNS records row shows.
    sp: broken ? (broken.issue === 'invalid_sp' ? (broken.sp ?? '') : null) : sp === 'none' || sp === 'quarantine' || sp === 'reject' ? sp : null,
    rua: ruaEntries(raw).map(ruaEntryAddress).filter(Boolean),
  };
}

/**
 * A resolver that answers the names in `known` from what the caller already fetched (no second subrequest), passes
 * everything else through, and notes whether `domain` itself came back NXDOMAIN.
 */
export function observingResolver(base: Resolver, domain: string, known: Record<string, TxtResult> = {}): Resolver & { apexNxdomain(): boolean } {
  let nx = false;
  const apex = domain.toLowerCase();
  return {
    ...base,
    resolve: base.resolve,
    async txt(name) {
      const key = name.toLowerCase();
      const r = known[key] ?? (await base.txt(name));
      if (key === apex && r.status === 'nxdomain') nx = true;
      return r;
    },
    apexNxdomain: () => nx,
  };
}

/** DMARC facts for a domain whose own `_dmarc.<domain>` answer was already fetched; the parent is looked up only when needed. */
export function dmarcFactsFor(resolver: Resolver, domain: string, own: TxtResult): Promise<DmarcFacts | undefined> {
  return dmarcLookupFor(resolver, domain, own).then(dmarcFactsFromLookup);
}

/** The full RFC 7489 lookup behind `dmarcFactsFor` (the record itself included), for callers that also show it. */
export function dmarcLookupFor(resolver: Resolver, domain: string, own: TxtResult): Promise<DmarcLookup> {
  const seeded = observingResolver(resolver, domain, { [`_dmarc.${domain.toLowerCase()}`]: own });
  return lookupDmarc(seeded, domain);
}

export interface DnsSnapshot {
  spf_record?: string | null;
  spf_lookup_count?: number;
  dmarc?: DmarcFacts;
  /** DNS says the domain itself does not exist (RCODE 3 for its TXT), as opposed to existing with no record. */
  nxdomain: boolean;
}

/**
 * Read a domain's SPF (with its lookup count) and effective DMARC from DNS, for the daily refresh. A lookup that
 * could not be answered leaves its field out. Subrequests: the SPF walk, 1 for `_dmarc.<domain>`, and 1 more for the
 * organizational domain when the domain has no DMARC record of its own.
 */
export async function snapshotDns(domain: string, base: Resolver = createResolver()): Promise<DnsSnapshot> {
  const resolver = observingResolver(base, domain);
  const out: DnsSnapshot = { nxdomain: false };
  try {
    const spf = await lookupSpf(domain, resolver); // throws on a DNS failure; null is an authoritative "no SPF"
    out.spf_record = spf?.raw ?? null;
    if (spf?.lookup_count !== undefined) out.spf_lookup_count = spf.lookup_count;
  } catch (e) {
    console.warn(`[monitor] SPF lookup refresh failed for ${domain}:`, e);
  }
  try {
    out.dmarc = dmarcFactsFromLookup(await lookupDmarc(resolver, domain));
    if (!out.dmarc) console.warn(`[monitor] DMARC lookup refresh failed for ${domain}`);
  } catch (e) {
    console.warn(`[monitor] DMARC lookup refresh failed for ${domain}:`, e);
  }
  out.nxdomain = resolver.apexNxdomain();
  return out;
}
