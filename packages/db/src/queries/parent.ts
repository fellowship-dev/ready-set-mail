import { and, eq, inArray, isNull } from 'drizzle-orm';
import { domainAncestry } from '@ready-set-mail/dns-checks/org-domain';
import type { Db } from '../client';
import { domains } from '../schema';

/**
 * The id of the nearest ancestor of `domain` this workspace lists, up to its organizational domain (public-suffix aware, never
 * above it): `cf-bounce.app.example.com` hangs under `app.example.com` when that is listed, else under `example.com`, even
 * when no row stands between them. Null when none is listed. The one rule behind `domains.parent_id`.
 */
export async function nearestListedAncestorId(db: Db, workspaceId: string, domain: string): Promise<number | null> {
	const ancestors = domainAncestry(domain).slice(1);
	if (ancestors.length === 0) return null;
	const rows = await db
		.select({ id: domains.id, domain: domains.domain })
		.from(domains)
		.where(and(eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at), inArray(domains.domain, ancestors)))
		.all();
	for (const name of ancestors) {
		const hit = rows.find((r) => r.domain === name);
		if (hit) return hit.id;
	}
	return null;
}
