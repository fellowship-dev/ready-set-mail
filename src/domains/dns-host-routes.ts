// GET /api/domains/dns-host?name=  who hosts this domain's DNS (read from its public NS records).
// Any member of the workspace may ask, about any valid public name: it reads public NS records only and stores nothing.
import { normalizeDomainName } from '@ready-set-mail/dns-checks';
import { resolverFor } from '../dns/resolver';
import type { TenantContext } from '../tenancy/context';
import { detectDnsHostFor, hasFreshDnsHost } from './dns-host';

const json = (data: unknown, status = 200, headers?: Record<string, string>) => Response.json(data, { status, headers });

export async function handleDnsHostRoute(request: Request, tenant: TenantContext, who: { userId?: string }): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/domains/dns-host' || request.method !== 'GET') return null;
  const parsed = normalizeDomainName(url.searchParams.get('name') ?? '');
  if (!parsed.ok) return json({ error: 'name must be a valid domain name' }, 400);
  // Only a cache miss runs DNS, so only a miss counts against the limit (same limiter as the DNS preview).
  if (tenant.env.DNS_PREVIEW_LIMITER && !hasFreshDnsHost(parsed.domain)) {
    const key = who.userId ? `user:${who.userId}` : `ws:${tenant.workspaceId}`;
    if (!(await tenant.env.DNS_PREVIEW_LIMITER.limit({ key })).success) return json({ error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 }, 429, { 'Retry-After': '60' });
  }
  return json(await detectDnsHostFor(parsed.domain, resolverFor(tenant.env)));
}
