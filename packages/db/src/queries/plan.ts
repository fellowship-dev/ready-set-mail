/**
 * The hosted plan (0017): one workspace's plan state, its subscription row, the lease every plan change runs under, and the cross-workspace
 * reads the webhook, the daily job and workspace creation need. The rules are in src/hosted/plan.ts; this file only reads and writes.
 *
 * `planQueries(db, workspaceId)` is scoped: every statement carries the workspace id.
 * `planLookups(db)` is the deliberately cross-workspace part (a person's allowance and owned workspaces, a subscription named by Stripe, the daily
 * sweep, workspace intents); each such read is marked `workspace-scope-exempt`.
 */
import { and, asc, eq, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import { unwrapDriverError, type Db, type DbLike, getDb } from '../client';
import { domains, memberships, users, workspaceIntents, workspaceSubscriptions, workspaces } from '../schema';
import { changesOf } from './plan-limit';

export type SubscriptionRow = typeof workspaceSubscriptions.$inferSelect;
export type IntentRow = typeof workspaceIntents.$inferSelect;
export type SubscriptionPatch = Partial<Omit<SubscriptionRow, 'workspace_id' | 'created_at'>>;

/** The lease on a workspace's plan changes: long enough for a Stripe round trip or two, short enough that a crashed Worker frees it soon. */
export const PLAN_LOCK_SECONDS = 45;

const now = sql`unixepoch()`;

export function planQueries(db: Db, workspaceId: string) {
	const mine = eq(workspaces.id, workspaceId);
	const myDomains = and(eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at));
	const mySub = eq(workspaceSubscriptions.workspace_id, workspaceId);
	return {
		workspaceId,
		/** The plan columns of the workspace, or null when it does not exist. */
		get: () => db.select({
			id: workspaces.id, name: workspaces.name, plan: workspaces.plan, free_owner_user_id: workspaces.free_owner_user_id, plan_revision: workspaces.plan_revision,
			stripe_customer_id: workspaces.stripe_customer_id, created_at: workspaces.created_at,
		}).from(workspaces).where(mine).get().then((r) => r ?? null),

		/** Live domain rows with what the plan needs to know about them. */
		rows: () => db.select({ id: domains.id, domain: domains.domain, org_domain: domains.org_domain, paused_at: domains.paused_at, verified_via: domains.verified_via, created_at: domains.created_at })
			.from(domains).where(myDomains).orderBy(asc(domains.id)).all(),

		/** Fill `org_domain` of rows that have none (SQL cannot compute the Public Suffix List). Returns how many rows were filled. */
		async fillOrgDomains(orgOf: (domain: string) => string): Promise<number> {
			const missing = await db.select({ id: domains.id, domain: domains.domain }).from(domains).where(and(myDomains, isNull(domains.org_domain))).all();
			let n = 0;
			for (const r of missing) {
				const org = orgOf(r.domain);
				if (org) n += changesOf(await db.update(domains).set({ org_domain: org }).where(and(eq(domains.id, r.id), eq(domains.workspace_id, workspaceId), isNull(domains.org_domain))).run());
			}
			return n;
		},

		lock: {
			/** Take the lease: true for the one caller that holds it now (an expired lease is taken over). */
			acquire: (token: string, nowSeconds: number) =>
				db.update(workspaces).set({ plan_lock_token: token, plan_lock_until: nowSeconds + PLAN_LOCK_SECONDS })
					.where(and(mine, sql`(${workspaces.plan_lock_token} IS NULL OR ${workspaces.plan_lock_until} IS NULL OR ${workspaces.plan_lock_until} < ${nowSeconds})`)).run().then((r) => changesOf(r) > 0),
			release: (token: string) => db.update(workspaces).set({ plan_lock_token: null, plan_lock_until: null }).where(and(mine, eq(workspaces.plan_lock_token, token))).run(),
			/** Is the lease still ours? (checked before the last write of a long change) */
			held: (token: string) => db.select({ t: workspaces.plan_lock_token }).from(workspaces).where(and(mine, eq(workspaces.plan_lock_token, token))).get().then((r) => !!r),
			/** Bump the revision (monotonic; part of every Stripe idempotency key) and return the new value. Only while holding the lease. */
			async bump(token: string): Promise<number | null> {
				const res = await db.update(workspaces).set({ plan_revision: sql`${workspaces.plan_revision} + 1` }).where(and(mine, eq(workspaces.plan_lock_token, token))).run();
				if (changesOf(res) === 0) return null;
				return db.select({ r: workspaces.plan_revision }).from(workspaces).where(mine).get().then((r) => r?.r ?? null);
			},
		},

		setPlan: (plan: 'free' | 'payg') => db.update(workspaces).set({ plan }).where(mine).run(),

		/** Hold the person's one free domain in this workspace, unless it holds one already: false when the person has an allowance elsewhere (the unique index decides a race). */
		async claimAllowance(userId: string): Promise<boolean> {
			try {
				return changesOf(await db.update(workspaces).set({ free_owner_user_id: userId }).where(and(mine, isNull(workspaces.free_owner_user_id))).run()) > 0;
			} catch (e) {
				const err = unwrapDriverError(e);
				if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
				throw e;
			}
		},
		releaseAllowance: () => db.update(workspaces).set({ free_owner_user_id: null }).where(mine).run(),

		/** Pause every live domain except the unit `keepOrg` (null: all). Returns the rows paused. */
		pauseExcept: (keepOrg: string | null, nowSeconds: number) =>
			db.update(domains).set({ paused_at: nowSeconds }).where(and(myDomains, isNull(domains.paused_at), keepOrg === null ? undefined : sql`COALESCE(${domains.org_domain}, ${domains.domain}) <> ${keepOrg}`)).run().then(changesOf),
		/** Resume the rows of one unit (the one an owner keeps free). */
		unpauseUnit: (org: string) => db.update(domains).set({ paused_at: null }).where(and(myDomains, isNotNull(domains.paused_at), sql`COALESCE(${domains.org_domain}, ${domains.domain}) = ${org}`)).run().then(changesOf),
		unpauseAll: () => db.update(domains).set({ paused_at: null }).where(and(myDomains, isNotNull(domains.paused_at))).run().then(changesOf),

		/** Undo a domain row added moments ago whose plan update failed: the row and its monitoring subscription go, nothing is remembered as removed. */
		async rollbackDomain(id: number, name: string): Promise<boolean> {
			await db.run(sql`DELETE FROM monitor_subscriptions WHERE workspace_id = ${workspaceId} AND domain = ${name}`);
			return changesOf(await db.delete(domains).where(and(eq(domains.workspace_id, workspaceId), eq(domains.id, id))).run()) > 0;
		},

		subscription: {
			get: () => db.select().from(workspaceSubscriptions).where(mySub).get().then((r) => r ?? null),
			insert: (row: Omit<SubscriptionRow, 'workspace_id' | 'created_at' | 'updated_at'>) => db.insert(workspaceSubscriptions).values({ ...row, workspace_id: workspaceId }).run(),
			patch: (fields: SubscriptionPatch) => db.update(workspaceSubscriptions).set({ ...fields, updated_at: now as unknown as number }).where(mySub).run(),
			remove: () => db.delete(workspaceSubscriptions).where(mySub).run(),
			markDirty: () => db.update(workspaceSubscriptions).set({ dirty: 1, updated_at: now as unknown as number }).where(mySub).run(),
		},
	};
}

/** The cross-workspace reads. Used by workspace creation, ownership transfer, the webhook, the daily job and the intake's plan check. */
export function planLookups(dbLike: DbLike) {
	const db: Db = getDb(dbLike);
	return {
		/** The workspace that holds this person's free domain, if any. */
		allowanceOf: (userId: string) => db.select({ id: workspaces.id }).from(workspaces).where(/* workspace-scope-exempt: a person's allowance is one row across all their workspaces */ eq(workspaces.free_owner_user_id, userId)).get().then((r) => r?.id ?? null),

		/** Workspaces a person owns, oldest first, with the status of each one's subscription (null: none). */
		ownedBy: (userId: string) =>
			db.select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, free_owner_user_id: workspaces.free_owner_user_id, status: workspaceSubscriptions.status, cancel_at_period_end: workspaceSubscriptions.cancel_at_period_end })
				.from(memberships).innerJoin(workspaces, eq(workspaces.id, memberships.workspace_id)).leftJoin(workspaceSubscriptions, eq(workspaceSubscriptions.workspace_id, workspaces.id))
				.where(/* workspace-scope-exempt: the workspaces a person owns, across all of them */ and(eq(memberships.user_id, userId), eq(memberships.role, 'owner')))
				.orderBy(asc(workspaces.created_at), asc(workspaces.id)).all(),

		/** Verified addresses of a workspace's owners (the instance-owner exemption is derived from these, never from a request). */
		ownerEmails: (workspaceId: string) =>
			db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.user_id)).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.role, 'owner'))).all().then((r) => r.map((x) => x.email)),

		workspaceBySubscription: (subscriptionId: string) =>
			db.select({ id: workspaceSubscriptions.workspace_id }).from(workspaceSubscriptions).where(/* workspace-scope-exempt: Stripe names a subscription, not a workspace */ eq(workspaceSubscriptions.stripe_subscription_id, subscriptionId)).get().then((r) => r?.id ?? null),

		/** Subscriptions the daily job should look at: never synced first, then the longest since a sync, plus every dirty one. */
		dueForSync: (limit: number) =>
			db.select().from(workspaceSubscriptions).where(/* workspace-scope-exempt: the daily job reconciles every pay-as-you-go workspace */ sql`1 = 1`)
				.orderBy(sql`${workspaceSubscriptions.dirty} DESC`, sql`${workspaceSubscriptions.synced_at} IS NOT NULL`, asc(workspaceSubscriptions.synced_at)).limit(limit).all(),

		/** Workspaces that still have domain rows without an organizational domain (the daily sweep fills them in). */
		withoutOrgDomain: (limit: number) =>
			db.selectDistinct({ id: domains.workspace_id }).from(domains).where(/* workspace-scope-exempt: the daily sweep covers every workspace */ and(isNull(domains.org_domain), isNull(domains.evicted_at))).limit(limit).all().then((r) => r.map((x) => x.id)),

		intents: {
			openCount: (userId: string) => db.select({ n: sql<number>`COUNT(*)` }).from(workspaceIntents).where(and(eq(workspaceIntents.user_id, userId), eq(workspaceIntents.status, 'open'))).get().then((r) => r?.n ?? 0),
			insert: (row: { id: string; user_id: string; name: string; stripe_customer_id: string | null }) => db.insert(workspaceIntents).values(row).run(),
			get: (id: string) => db.select().from(workspaceIntents).where(eq(workspaceIntents.id, id)).get().then((r) => r ?? null),
			setCustomer: (id: string, customerId: string) => db.update(workspaceIntents).set({ stripe_customer_id: customerId }).where(and(eq(workspaceIntents.id, id), eq(workspaceIntents.status, 'open'))).run(),
			/** open → created, once: true for the one caller that should create the workspace. */
			claim: (id: string) => db.update(workspaceIntents).set({ status: 'created', completed_at: now as unknown as number }).where(and(eq(workspaceIntents.id, id), eq(workspaceIntents.status, 'open'))).run().then((r) => changesOf(r) > 0),
			/** Put a claimed intent back (the workspace could not be created: a cap, or a failure). */
			reopen: (id: string) => db.update(workspaceIntents).set({ status: 'open', completed_at: null }).where(and(eq(workspaceIntents.id, id), eq(workspaceIntents.status, 'created'))).run(),
			purge: (beforeSeconds: number) => db.delete(workspaceIntents).where(lt(workspaceIntents.created_at, beforeSeconds)).run().then(changesOf),
		},
	};
}
