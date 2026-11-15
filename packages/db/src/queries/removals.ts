/** Names a person removed from the workspace, so Cloudflare auto-import does not add them back (0015). */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { removedDomains } from '../schema';

export function removalQueries(db: Db, workspaceId: string) {
	const mine = eq(removedDomains.workspace_id, workspaceId);
	return {
		async remember(domain: string): Promise<void> {
			await db.insert(removedDomains).values({ workspace_id: workspaceId, domain: domain.toLowerCase() }).onConflictDoNothing().run();
		},
		async forget(domain: string): Promise<void> {
			await db.delete(removedDomains).where(and(mine, eq(removedDomains.domain, domain.toLowerCase()))).run();
		},
		async names(): Promise<Set<string>> {
			return new Set((await db.select({ domain: removedDomains.domain }).from(removedDomains).where(mine).all()).map((r) => r.domain));
		},
	};
}
