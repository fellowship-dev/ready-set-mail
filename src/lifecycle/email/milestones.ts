// The one stored fact the lifecycle emails need and the analytics cannot give them: when a domain's records were first seen live, and by whom.
//
// Written from the same call sites as the analytics event (src/product-analytics/steps.ts `recordsSeenLive`), but unconditionally: the analytics
// markers exist only when PostHog is configured, and an email must not depend on that. One INSERT OR IGNORE; the first sight wins.
//   app  a person's own read (the setup screens, the domain page): they were looking, so no "records live" email.
//   job  a scheduled read: the person was not looking, so the lifecycle job tells them.

import type { LiveSeenBy } from '@ready-set-mail/db';
import type { TenantContext } from '../../tenancy/context';

export const seenByOf = (seenBy: 'setup' | 'domain_page' | 'daily'): LiveSeenBy => (seenBy === 'daily' ? 'job' : 'app');

/** Record the first sight of a domain's records live. True when this call wrote it. Never throws. */
export async function markRecordsLive(tenant: Pick<TenantContext, 'scope'>, domainId: number, by: LiveSeenBy, atSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  try {
    return await tenant.scope.lifecycleEmail.milestones.recordLive(domainId, by, atSeconds);
  } catch (e) {
    console.error('[lifecycle] milestone not recorded:', e instanceof Error ? e.name : 'error');
    return false;
  }
}

/** The hook for the call sites: returns at once, the write runs after the response when a context is given. */
export function noteRecordsLive(tenant: Pick<TenantContext, 'scope'>, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, domainId: number, seenBy: 'setup' | 'domain_page' | 'daily'): void {
  const work = markRecordsLive(tenant, domainId, seenByOf(seenBy));
  try { ctx?.waitUntil(work); } catch { /* the write was started either way */ }
}
