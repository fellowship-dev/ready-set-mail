// The names seen sending as a domain: each subdomain that appears in its reports as a From domain or as a return-path (SPF) domain, with its
// volume, what the receivers decided, the policy that applies to the NAME and where it comes from, and the one thing to fix.
//
// Built from the reports already stored plus one DMARC read per name (the shared `lookupDmarc`, whose `effective` is the one rule:
// packages/dns-checks/src/effective-policy.ts). A name is part of its domain, never a sibling row: this is what the domain's page lists.
import { decodeTxtData, effectivePolicySentence, lookupDmarc, type EffectivePolicy, type Resolver } from '@ready-set-mail/dns-checks';
import type { NameSeenRow } from '@ready-set-mail/db';

/** How many names get a DNS read (the busiest first): a hard bound on the subrequests of one request. */
export const NAMES_READ_LIMIT = 12;

export interface NameSeen {
  name: string;
  /** Where the name appears in the reports: as the From domain, as the return-path (SPF) domain, or both. */
  roles: Array<'from' | 'return-path'>;
  /** Messages with this name as From (the volume the receivers judge DMARC on); the return-path name's volume when it is only that. */
  messages: number;
  passed: number;
  failed: number;
  /** The policy that applies to this name: its tag and where the record is; null when the name was not read (over the limit). */
  effective: (EffectivePolicy & { pct: number | null }) | null;
  /** The policy and where it comes from, in one sentence; null when not read or when no policy applies. */
  source: string | null;
  /** The one thing to fix, in a sentence; null: nothing. */
  fix: string | null;
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;

/** The one thing to fix for a name, in order: failing mail first (that is what hurts), then a policy that enforces nothing. */
export function fixFor(n: Pick<NameSeen, 'name' | 'roles' | 'messages' | 'failed'>, effective: EffectivePolicy | null): string | null {
  if (n.roles.includes('from') && n.failed > 0) {
    return `${plural(n.failed, 'message')} sent as ${n.name} failed DMARC because neither SPF nor DKIM aligned with it: open the failing senders for the identifier that did not align and the fix.`;
  }
  if (!n.roles.includes('from')) return null; // only a return-path: nothing is sent as it
  if (!effective) return null;
  if (effective.status === 'error') return `The DMARC record for ${n.name} could not be read just now.`;
  if (effective.status === 'none') return `No DMARC record covers ${n.name}: publish one at _dmarc.${n.name}, or at its organizational domain.`;
  if (effective.status === 'multiple') return `There are several DMARC records at _dmarc.${effective.at}: keep one.`;
  if (effective.status === 'broken') return `The DMARC record at _dmarc.${effective.at} is not valid as written: receivers apply ${effective.policy ? `p=${effective.policy}` : 'no DMARC'} instead. Fix its p= or sp=.`;
  if (effective.policy === 'none') return `Mail that fails DMARC from ${n.name} is still delivered: the policy that applies is ${effective.tag}=none${effective.source === 'organizational' ? ` on ${effective.at}'s record` : ''}. Move it to quarantine, then reject, once its reports pass.`;
  return null;
}

/** A resolver that asks DNS once per name and type for the length of one request (the names share their organizational domain's record). */
function memoized(base: Resolver): Resolver {
  const seen = new Map<string, ReturnType<Resolver['resolve']>>();
  const resolve: Resolver['resolve'] = (name, type) => {
    const key = `${type} ${name.toLowerCase()}`;
    let hit = seen.get(key);
    if (!hit) { hit = base.resolve(name, type); seen.set(key, hit); }
    return hit;
  };
  return {
    ...base,
    resolve,
    txt: async (name) => {
      const r = await resolve(name, 'TXT');
      return { status: r.status, records: r.answers.map((a) => decodeTxtData(a.data)), ...(r.error ? { error: r.error } : {}) };
    },
  };
}

export async function namesSeen(rows: readonly NameSeenRow[], resolver: Resolver, limit = NAMES_READ_LIMIT): Promise<NameSeen[]> {
  const byName = new Map<string, { from?: NameSeenRow; returnPath?: NameSeenRow }>();
  for (const r of rows) {
    const e = byName.get(r.name) ?? {};
    if (r.role === 'from') e.from = r; else e.returnPath = r;
    byName.set(r.name, e);
  }
  // DMARC is judged per message on its From domain: a name's volume and verdict are its From role's; a return-path-only name shows its own volume.
  const names: NameSeen[] = [...byName.entries()].map(([name, e]) => ({
    name,
    roles: [...(e.from ? ['from' as const] : []), ...(e.returnPath ? ['return-path' as const] : [])],
    messages: (e.from ?? e.returnPath)!.messages,
    passed: e.from?.passed ?? 0,
    failed: e.from?.failed ?? 0,
    effective: null, source: null, fix: null,
  })).sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  const dns = memoized(resolver);
  await Promise.all(names.slice(0, limit).map(async (n) => {
    if (!n.roles.includes('from')) return; // a return-path name sends nothing as itself: its DMARC policy is not asked
    const l = await lookupDmarc(dns, n.name).catch(() => null);
    if (!l) return;
    n.effective = { ...l.effective, pct: l.record?.pct ?? null };
    n.source = effectivePolicySentence(n.name, l.effective);
  }));
  for (const n of names) n.fix = fixFor(n, n.effective);
  return names;
}
