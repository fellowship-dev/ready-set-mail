/**
 * Email-funnel queries: the suppression list and the lead rows the retired follow-up sequence left behind (only ever deleted now).
 * Both tables are global (platform marketing data, see GLOBAL_TABLES), so nothing here touches tenant data except `deleteSubscriptionsFor`, which an
 * unsubscribe needs: it removes one address from every workspace's monitor subscriptions.
 */
import { eq, lt } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { leads, suppression, monitorSubscriptions } from '../schema';

/** SHA-256 hex of the normalised (trimmed, lower-cased) address: the only form in which a suppressed address is kept. */
export async function hashEmail(email: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function funnelQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		suppression: {
			add: async (email: string, reason: string) =>
				db.insert(suppression).values({ email_hash: await hashEmail(email), reason }).onConflictDoNothing().run(),
			has: async (email: string) => !!(await db.select({ h: suppression.email_hash }).from(suppression).where(eq(suppression.email_hash, await hashEmail(email))).get()),
		},

		leads: {
			delete: (email: string) => db.delete(leads).where(eq(leads.email, email)).run(),

			/** Retention: leads with no activity since `cutoff`. */
			deleteInactiveBefore: (cutoff: number) => db.delete(leads).where(lt(leads.last_activity_at, cutoff)).run().then((r) => r.meta.changes ?? 0),
		},

		/** An unsubscribed address leaves every workspace's change-alert subscriptions too. */
		deleteSubscriptionsFor: (email: string) =>
			db.delete(monitorSubscriptions).where(/* workspace-scope-exempt: an unsubscribe applies to the address in every workspace */ eq(monitorSubscriptions.email, email)).run(),
	};
}
