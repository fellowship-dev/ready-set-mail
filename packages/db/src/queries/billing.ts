/**
 * Hosted billing (0016): orders, the Checkout sessions that add a card, the Stripe event ledger and the price cache.
 *
 * `billingQueries(db, workspaceId)` is what a signed-in workspace member's request uses: every statement carries the
 * workspace id, so another workspace's order or session is simply not found.
 * `billingLookups(db)` is the deliberately cross-workspace part (the Stripe webhook and the instance owner find a row by an id
 * Stripe or the operator supplies, before any workspace is known; the daily job sweeps). Each such read is marked
 * `workspace-scope-exempt`; once a row is in hand every write goes through the scoped queries with the row's own workspace id.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb, unwrapDriverError, type Db, type DbLike } from '../client';
import { billingCheckoutSessions, billingEvents, billingOrders, billingPriceCache, workspacePlans, workspaces, type OrderStatus } from '../schema';
import { changesOf } from './plan-limit';

export type OrderRow = typeof billingOrders.$inferSelect;
export type NewOrder = Omit<typeof billingOrders.$inferInsert, 'workspace_id' | 'status' | 'created_at' | 'updated_at'>;
export type CheckoutSessionRow = typeof billingCheckoutSessions.$inferSelect;
export type PriceCacheRow = typeof billingPriceCache.$inferSelect;
export type PlanRow = typeof workspacePlans.$inferSelect;
/** Statuses in which an order holds its domain's single slot (the partial unique index `idx_billing_orders_open`). */
export const OPEN_ORDER_STATUSES = ['pending', 'paid', 'started'] as const satisfies readonly OrderStatus[];

/** Fields an update may set. Status moves go through `move` so they are conditional on the current status. */
export type OrderPatch = Partial<Omit<OrderRow, 'id' | 'workspace_id' | 'status' | 'created_at'>>;

const now = sql`unixepoch()`;

export function billingQueries(dbLike: DbLike, workspaceId: string) {
	const db: Db = getDb(dbLike);
	const mine = eq(billingOrders.workspace_id, workspaceId);
	const mySessions = eq(billingCheckoutSessions.workspace_id, workspaceId);
	return {
		workspaceId,
		customer: {
			get: () => db.select({ id: workspaces.stripe_customer_id }).from(workspaces).where(eq(workspaces.id, workspaceId)).get().then((r) => r?.id ?? null),
			/** Store the customer id only if there is none yet: of two concurrent creators exactly one row update wins; the caller re-reads. */
			claim: (customerId: string) => db.update(workspaces).set({ stripe_customer_id: customerId }).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.stripe_customer_id))).run().then((r) => changesOf(r) > 0),
			/** Forget the customer when Stripe says it is gone (only if it is still that one). */
			clear: (customerId: string) => db.update(workspaces).set({ stripe_customer_id: null }).where(and(eq(workspaces.id, workspaceId), eq(workspaces.stripe_customer_id, customerId))).run().then((r) => changesOf(r) > 0),
		},

		/** The hosted plan row (0026): the interval, the one subscription and what was last billed. */
		plan: {
			get: () => db.select().from(workspacePlans).where(eq(workspacePlans.workspace_id, workspaceId)).get().then((r) => r ?? null),
			/** Choose the interval; refused (false) once a subscription exists. */
			async choose(interval: 'month' | 'year'): Promise<boolean> {
				await db.insert(workspacePlans).values({ workspace_id: workspaceId, interval }).onConflictDoNothing().run();
				return db.update(workspacePlans).set({ interval }).where(and(eq(workspacePlans.workspace_id, workspaceId), isNull(workspacePlans.stripe_subscription_id))).run().then((r) => changesOf(r) > 0);
			},
			/** Make sure a row exists (default interval) so the daily job finds it. */
			ensure: () => db.insert(workspacePlans).values({ workspace_id: workspaceId }).onConflictDoNothing().run(),
			/** Store the subscription the first time (only if none is stored yet): true for the one caller that stored it. */
			attach: (subscriptionId: string, itemId: string, quantity: number, nowSeconds: number) =>
				db.update(workspacePlans).set({ stripe_subscription_id: subscriptionId, stripe_item_id: itemId, quantity, synced_at: nowSeconds, sync_error: null })
					.where(and(eq(workspacePlans.workspace_id, workspaceId), isNull(workspacePlans.stripe_subscription_id))).run().then((r) => changesOf(r) > 0),
			synced: (quantity: number, nowSeconds: number) => db.update(workspacePlans).set({ quantity, synced_at: nowSeconds, sync_error: null }).where(eq(workspacePlans.workspace_id, workspaceId)).run(),
			failed: (message: string) => db.update(workspacePlans).set({ sync_error: message.slice(0, 200) }).where(eq(workspacePlans.workspace_id, workspaceId)).run(),
		},

		orders: {
			/** Insert a pending order. `existing` is the open order for the same domain and offer when this one lost the race for its slot. */
			async insert(o: NewOrder): Promise<{ ok: true } | { ok: false; existing: OrderRow }> {
				try {
					await db.insert(billingOrders).values({ ...o, workspace_id: workspaceId, status: 'pending' }).run();
					return { ok: true };
				} catch (e) {
					const err = unwrapDriverError(e);
					if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
						const existing = await db.select().from(billingOrders)
							.where(and(mine, eq(billingOrders.domain_name, o.domain_name), eq(billingOrders.offer, o.offer), inArray(billingOrders.status, [...OPEN_ORDER_STATUSES]))).get();
						if (existing) return { ok: false, existing };
					}
					throw e;
				}
			},
			get: (id: string) => db.select().from(billingOrders).where(and(mine, eq(billingOrders.id, id))).get().then((r) => r ?? null),
			list: (limit = 100) => db.select().from(billingOrders).where(mine).orderBy(desc(billingOrders.created_at), desc(billingOrders.id)).limit(limit).all(),
			forDomain: (domainName: string) => db.select().from(billingOrders).where(and(mine, eq(billingOrders.domain_name, domainName))).orderBy(desc(billingOrders.created_at), desc(billingOrders.id)).all(),
			open: (domainName: string, offer: string) =>
				db.select().from(billingOrders).where(and(mine, eq(billingOrders.domain_name, domainName), eq(billingOrders.offer, offer), inArray(billingOrders.status, [...OPEN_ORDER_STATUSES]))).get().then((r) => r ?? null),
			/** Set fields without changing the status. */
			patch: (id: string, fields: OrderPatch) => db.update(billingOrders).set({ ...fields, updated_at: now as unknown as number }).where(and(mine, eq(billingOrders.id, id))).run(),
			/** Claim the one operator alert of this order: true for the single caller that should send it. */
			alertOnce: (id: string) =>
				db.update(billingOrders).set({ operator_alerted_at: now as unknown as number }).where(and(mine, eq(billingOrders.id, id), isNull(billingOrders.operator_alerted_at))).run().then((r) => changesOf(r) > 0),
			/**
			 * Move to `to` only from one of `from`: one conditional statement. True when this call made the move, so exactly one caller
			 * performs the side effects (audit, the owner's email) of a transition.
			 */
			move: (id: string, from: readonly OrderStatus[], to: OrderStatus, fields: OrderPatch = {}) =>
				db.update(billingOrders).set({ ...fields, status: to, updated_at: now as unknown as number }).where(and(mine, eq(billingOrders.id, id), inArray(billingOrders.status, [...from]))).run().then((r) => changesOf(r) > 0),
		},

		sessions: {
			insert: (s: { ref: string; user_id: string; purpose: string; return_path: string; stripe_customer_id: string }) =>
				db.insert(billingCheckoutSessions).values({ ...s, workspace_id: workspaceId }).run(),
			attach: (ref: string, stripeSessionId: string) => db.update(billingCheckoutSessions).set({ stripe_session_id: stripeSessionId }).where(and(mySessions, eq(billingCheckoutSessions.ref, ref))).run(),
			drop: (ref: string) => db.delete(billingCheckoutSessions).where(and(mySessions, eq(billingCheckoutSessions.ref, ref), isNull(billingCheckoutSessions.stripe_session_id))).run(),
			byStripeId: (stripeSessionId: string) => db.select().from(billingCheckoutSessions).where(and(mySessions, eq(billingCheckoutSessions.stripe_session_id, stripeSessionId))).get().then((r) => r ?? null),
			/** open → completed, once: true for the one caller that completed it. */
			complete: (ref: string) => db.update(billingCheckoutSessions).set({ status: 'completed', completed_at: now as unknown as number }).where(and(mySessions, eq(billingCheckoutSessions.ref, ref), eq(billingCheckoutSessions.status, 'open'))).run().then((r) => changesOf(r) > 0),
		},
	};
}

/** The cross-workspace reads. Only the webhook, the instance owner's orders list and the daily job import this. */
export function billingLookups(dbLike: DbLike) {
	const db: Db = getDb(dbLike);
	return {
		orderById: (id: string) => db.select().from(billingOrders).where(/* workspace-scope-exempt: the instance owner and the webhook find an order by its id before any workspace is known */ eq(billingOrders.id, id)).get().then((r) => r ?? null),
		orderByInvoice: (invoiceId: string) => db.select().from(billingOrders).where(/* workspace-scope-exempt: Stripe names an invoice, not a workspace */ eq(billingOrders.stripe_invoice_id, invoiceId)).get().then((r) => r ?? null),
		orderByCharge: (chargeId: string, paymentIntentId?: string | null) =>
			db.select().from(billingOrders).where(/* workspace-scope-exempt: Stripe names a charge, not a workspace */ sql`${billingOrders.stripe_charge_id} = ${chargeId} OR (${paymentIntentId ?? null} IS NOT NULL AND ${billingOrders.stripe_payment_intent_id} = ${paymentIntentId ?? null})`).get().then((r) => r ?? null),
		/** The instance owner's list: every workspace, newest first. */
		allOrders: (opts: { status?: OrderStatus; limit?: number } = {}) =>
			db.select().from(billingOrders).where(/* workspace-scope-exempt: the instance owner sees orders of every workspace */ opts.status ? eq(billingOrders.status, opts.status) : undefined).orderBy(desc(billingOrders.created_at), desc(billingOrders.id)).limit(Math.min(opts.limit ?? 100, 200)).all(),
		/** Pending orders last touched before `beforeSeconds`, oldest first. */
		stalePending: (beforeSeconds: number, limit: number) =>
			db.select().from(billingOrders).where(/* workspace-scope-exempt: the daily job reconciles every workspace */ and(eq(billingOrders.status, 'pending'), lt(billingOrders.updated_at, beforeSeconds))).orderBy(asc(billingOrders.updated_at)).limit(limit).all(),
		/** Paid orders whose notice to the instance owner has not gone out. */
		unnotified: (limit: number) =>
			db.select().from(billingOrders).where(/* workspace-scope-exempt: the daily job retries every workspace's owner notices */ and(eq(billingOrders.status, 'paid'), isNull(billingOrders.owner_notified_at))).orderBy(asc(billingOrders.paid_at)).limit(limit).all(),
		/** Accounting retention: delete orders created before the cutoff. Returns how many. */
		purgeOrdersBefore: (cutoffSeconds: number) =>
			db.delete(billingOrders).where(/* workspace-scope-exempt: retention covers every workspace */ lt(billingOrders.created_at, cutoffSeconds)).run().then(changesOf),
		markNotified: (workspaceId: string, id: string) => db.update(billingOrders).set({ owner_notified_at: now as unknown as number }).where(and(eq(billingOrders.workspace_id, workspaceId), eq(billingOrders.id, id))).run(),

		sessionByStripeId: (stripeSessionId: string) =>
			db.select().from(billingCheckoutSessions).where(/* workspace-scope-exempt: the webhook names a session, not a workspace */ eq(billingCheckoutSessions.stripe_session_id, stripeSessionId)).get().then((r) => r ?? null),
		/** Sessions never sent to Stripe (a day old) or finished long ago (30 days). */
		purgeSessions: (nowSeconds: number) =>
			db.delete(billingCheckoutSessions).where(/* workspace-scope-exempt: retention covers every workspace */ sql`(${billingCheckoutSessions.stripe_session_id} IS NULL AND ${billingCheckoutSessions.created_at} < ${nowSeconds - 86400}) OR ${billingCheckoutSessions.created_at} < ${nowSeconds - 30 * 86400}`).run().then(changesOf),

		/** The workspace a Stripe customer belongs to (the table is the tenant registry, not tenant data). */
		workspaceByCustomer: (customerId: string) => db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.stripe_customer_id, customerId)).get().then((r) => r?.id ?? null),
		/** Every workspace with a plan row: the daily job syncs them all. */
		planWorkspaces: () => db.select({ id: workspacePlans.workspace_id }).from(workspacePlans).where(/* workspace-scope-exempt: the daily job re-syncs every workspace that has a plan */ undefined).all().then((r) => r.map((x) => x.id)),
		workspaceName: (workspaceId: string) => db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).get().then((r) => r?.name ?? null),

		events: {
			/** Record an event as seen. True when this call inserted it (first delivery). */
			async begin(id: string, type: string): Promise<boolean> {
				return db.insert(billingEvents).values({ id, type }).onConflictDoNothing().run().then((r) => changesOf(r) > 0);
			},
			get: (id: string) => db.select().from(billingEvents).where(eq(billingEvents.id, id)).get().then((r) => r ?? null),
			/** Take over an event that failed, or whose processing started more than `staleSeconds` ago and never finished. */
			reclaim: (id: string, staleSeconds: number, nowSeconds: number) =>
				db.update(billingEvents).set({ status: 'processing', attempts: sql`${billingEvents.attempts} + 1`, updated_at: now as unknown as number })
					.where(and(eq(billingEvents.id, id), sql`(${billingEvents.status} = 'failed' OR (${billingEvents.status} = 'processing' AND ${billingEvents.updated_at} < ${nowSeconds - staleSeconds}))`)).run().then((r) => changesOf(r) > 0),
			finish: (id: string, status: 'done' | 'ignored' | 'failed', outcome: string) =>
				db.update(billingEvents).set({ status, outcome: outcome.slice(0, 80), updated_at: now as unknown as number }).where(eq(billingEvents.id, id)).run(),
			purgeBefore: (cutoffSeconds: number) => db.delete(billingEvents).where(lt(billingEvents.received_at, cutoffSeconds)).run().then(changesOf),
		},

		price: {
			get: (lookupKey: string) => db.select().from(billingPriceCache).where(eq(billingPriceCache.lookup_key, lookupKey)).get().then((r) => r ?? null),
			put: (row: PriceCacheRow) => db.insert(billingPriceCache).values(row).onConflictDoUpdate({ target: billingPriceCache.lookup_key, set: { price_id: row.price_id, amount: row.amount, currency: row.currency, fetched_at: row.fetched_at } }).run(),
			drop: (lookupKey: string) => db.delete(billingPriceCache).where(eq(billingPriceCache.lookup_key, lookupKey)).run(),
		},
	};
}
