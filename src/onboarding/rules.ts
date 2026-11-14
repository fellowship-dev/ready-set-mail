// The Email Routing rules of a zone, read completely or not at all.
import type { CfClient } from '../tenancy/cf-client';

/** An Email Routing rule as Cloudflare lists it. */
export interface EmailRule { id?: string; enabled?: boolean; matchers?: { type: string; field?: string; value?: string }[]; actions?: { type: string; value?: string[] }[] }

/** Every rule of the zone (all pages). Throws when the list cannot be read in full: never a partial list. */
export function listEmailRules(cf: Pick<CfClient, 'listAll'>, zoneId: string): Promise<EmailRule[]> {
  return cf.listAll<EmailRule>(`/zones/${zoneId}/email/routing/rules`);
}
