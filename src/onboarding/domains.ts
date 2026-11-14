// Which domain ids the onboarding module may act on. `domains` only ever holds verified domains of a workspace (a pending
// claim lives in `domain_claims` and has its own id space), so an id is accepted only when it is a live row of THIS workspace.
// Hosted: a row admitted through a parent that has since left the workspace is not proven any more, so it gets no writes either.
// Anything else (another workspace's id, a claim id, an unknown id) resolves to nothing and is ignored.

import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';
import { isDomainProven } from '../domains/ownership';

export async function writableDomains(tenant: TenantContext, ids: number[]) {
  const rows = (await Promise.all([...new Set(ids)].map(id => tenant.scope.domains.getById(id)))).filter(<T>(r: T | null | undefined): r is T => !!r);
  if (getMode(tenant.env) !== 'saas') return rows;
  const proven = await Promise.all(rows.map(async r => (r.verified_via === 'parent' ? await isDomainProven(tenant, r) : true)));
  return rows.filter((_, i) => proven[i]);
}
