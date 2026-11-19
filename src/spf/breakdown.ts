// Where the DNS lookups of a domain's SPF record go, term by term, for the person who cuts them by hand (the step "Bring SPF down to 10 DNS lookups or fewer").
// Reading only, for every workspace: it is the by-hand way to the same end as flattening, so it does not wait on the add-on. The walk is the engine's
// (packages/dns-checks/src/spf-flatten.ts lookupBreakdown): the same reads, the same bound.

import { isSpfRecord, lookupBreakdown, type Resolver, type SpfBreakdown } from '@ready-set-mail/dns-checks';
import { resolverFor } from '../dns/resolver';
import type { TenantContext } from '../tenancy/context';

export type SpfLookupsView =
  | { ok: true; record: string; /** The record is the one published now, or the original that flattening keeps (what the person would edit). */ source: 'published' | 'original'; total: number; items: Extract<SpfBreakdown, { ok: true }>['items'] }
  | { ok: false; message: string };

export async function spfLookupsView(tenant: TenantContext, domain: { id: number; domain: string }, resolver: Resolver = resolverFor(tenant.env)): Promise<SpfLookupsView> {
  const row = await tenant.scope.spf.get(domain.id);
  let record = row?.canonical_record ?? null;
  if (!record) {
    const txt = await resolver.txt(domain.domain);
    if (txt.status === 'error' || txt.truncated) return { ok: false, message: `We could not read the SPF record of ${domain.domain} (${txt.error ?? 'the answer was cut short'}).` };
    const spf = txt.records.filter(r => isSpfRecord(r));
    if (spf.length > 1) return { ok: false, message: `${domain.domain} publishes more than one SPF record, so there is no single count to break down.` };
    record = spf[0]?.trim() ?? null;
  }
  if (!record) return { ok: false, message: `${domain.domain} has no SPF record.` };
  const b = await lookupBreakdown(domain.domain, record, resolver);
  return b.ok ? { ok: true, record, source: row ? 'original' : 'published', total: b.total, items: b.items } : { ok: false, message: b.message };
}
