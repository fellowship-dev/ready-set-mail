// The Email Routing rules of a zone, read completely or not at all.
import { LIST_MAX_ITEMS, LIST_PER_PAGE, type CfClient } from '../tenancy/cf-client';

/** An Email Routing rule as Cloudflare lists it. */
export interface EmailRule { id?: string; enabled?: boolean; matchers?: { type: string; field?: string; value?: string }[]; actions?: { type: string; value?: string[] }[] }

/**
 * Every rule of the zone (all pages). Throws when the list cannot be read in full: never a partial list.
 * `justWritten` raises the caps by the rules this run has just added, so a zone that was read at exactly the cap can still be read back.
 */
export function listEmailRules(cf: Pick<CfClient, 'listAll'>, zoneId: string, justWritten = 0): Promise<EmailRule[]> {
  if (justWritten <= 0) return cf.listAll<EmailRule>(`/zones/${zoneId}/email/routing/rules`);
  return cf.listAll<EmailRule>(`/zones/${zoneId}/email/routing/rules`, {}, {
    maxItems: LIST_MAX_ITEMS + justWritten,
    maxPages: Math.ceil((LIST_MAX_ITEMS + justWritten) / LIST_PER_PAGE),
  });
}
