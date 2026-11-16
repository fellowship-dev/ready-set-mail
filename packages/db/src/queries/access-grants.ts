import { and, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { inChunks } from './in-list';
import { accessPrincipals, accessGrants, accessCredentials, products, productDomains, domains, settings } from '../schema';

/**
 * Every agent connection record joined to its principal: who approved it (`user_id`), whether it was revoked (`disabled_at`), which app (`client_id`) and when it was
 * approved and when it ends (unix seconds). The record is a settings row `<prefix><principal id>`; CASE keeps json_extract away from every other setting's value, which
 * need not be JSON. Callers add their own conditions; this alone reads connections in every workspace.
 */
const connectionRowsOf = (db: ReturnType<typeof getDb>) => (prefix: string) => db
 .select({
  workspace_id: settings.workspace_id, key: settings.key, principal_id: accessPrincipals.id, user_id: accessPrincipals.user_id, disabled_at: accessPrincipals.disabled_at,
  client_id: sql<string | null>`CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.clientId') END`.as('client_id'),
  expires_at: sql<number | null>`CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.expiresAt') END`.as('expires_at'),
  created_at: sql<number | null>`CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.createdAt') END`.as('created_at'),
 })
 .from(settings)
 .innerJoin(accessPrincipals, and(eq(accessPrincipals.workspace_id, settings.workspace_id), sql`${settings.key} = ${prefix} || ${accessPrincipals.id}`))
 .where(/* workspace-scope-exempt: connection records of every workspace; each caller narrows by person, workspace or end date */ sql`substr(${settings.key}, 1, ${prefix.length}) = ${prefix}`)
 .as('connections');
type ConnectionRows = ReturnType<ReturnType<typeof connectionRowsOf>>;
/** A connection that works now: not revoked, and its end date is ahead. */
const live = (rows: ConnectionRows, nowSeconds: number): SQL => sql`(${rows.disabled_at} IS NULL AND ${rows.expires_at} > ${nowSeconds})`;

/** The only unscoped reads identify a credential/principal before selecting its workspace. */
export function accessLookups(dbLike: DbLike) {
 const db = getDb(dbLike);
 const connectionRows = connectionRowsOf(db);
 return {
  credentialById: (id: string) => db.select().from(accessCredentials).where(/* workspace-scope-exempt: rechecking the authenticated credential */ eq(accessCredentials.id, id)).get(),
  credentialByHash: (hash: string) => db.select().from(accessCredentials).where(/* workspace-scope-exempt: credential hash identifies its workspace */ eq(accessCredentials.key_hash, hash)).get(),
  principalById: (id: string) => db.select().from(accessPrincipals).where(/* workspace-scope-exempt: resolving an authenticated principal identity */ eq(accessPrincipals.id, id)).get(),
  humanPrincipalsForUser: (userId: string) => db.select().from(accessPrincipals).where(/* workspace-scope-exempt: own-user connection management survives membership removal */ and(eq(accessPrincipals.user_id, userId), eq(accessPrincipals.kind, 'human'))).all(),
  /**
   * Which of these app ids appear in an agent connection record, in any workspace and in any state (live, revoked or ended): the apps a person approved at least once.
   * Asked in pieces of IN_LIST_MAX: D1 binds at most 100 values per statement.
   */
  connectedClientIds: async (prefix: string, clientIds: string[]): Promise<Set<string>> => {
   const found = new Set<string>(), rows = connectionRows(prefix);
   for (const part of inChunks(clientIds)) for (const r of await db.selectDistinct({ id: rows.client_id }).from(rows).where(inArray(rows.client_id, part)).all()) if (r.id) found.add(r.id);
   return found;
  },
  /**
   * How many distinct registered apps have a LIVE connection, in any workspace: the apps a registration ceiling must not evict. Live is a connection whose principal is
   * not disabled (revoked) and whose record has not ended. An app that publishes a client ID metadata document (an https client id) is not stored by us, so it is not counted.
   */
  liveConnectedClientCount: async (prefix: string, nowSeconds: number): Promise<number> => {
   const rows = connectionRows(prefix);
   const row = await db.select({ n: sql<number>`COUNT(DISTINCT ${rows.client_id})` }).from(rows).where(and(live(rows, nowSeconds), sql`${rows.client_id} NOT LIKE 'https://%'`)).get();
   return row?.n ?? 0;
  },
  /** One person's connections: how many are live now, and how many were approved since `sinceSeconds` (revoked ones included: approving is what is limited). */
  connectionsOfPerson: async (prefix: string, userId: string, nowSeconds: number, sinceSeconds: number): Promise<{ live: number; approvedSince: number }> => {
   const rows = connectionRows(prefix);
   const row = await db.select({ live: sql<number | null>`SUM(CASE WHEN ${live(rows, nowSeconds)} THEN 1 ELSE 0 END)`, recent: sql<number | null>`SUM(CASE WHEN ${rows.created_at} >= ${sinceSeconds} THEN 1 ELSE 0 END)` }).from(rows).where(eq(rows.user_id, userId)).get();
   return { live: row?.live ?? 0, approvedSince: row?.recent ?? 0 };
  },
  /** How many live connections a workspace has (whoever approved them). */
  liveConnectionsInWorkspace: async (prefix: string, workspaceId: string, nowSeconds: number): Promise<number> => {
   const rows = connectionRows(prefix);
   const row = await db.select({ n: sql<number>`COUNT(*)` }).from(rows).where(and(eq(rows.workspace_id, workspaceId), live(rows, nowSeconds))).get();
   return row?.n ?? 0;
  },
  /** Connections that ended (revoked, or past their end date) before `cutoffSeconds`, oldest first. */
  endedConnections: async (prefix: string, cutoffSeconds: number, limit: number) => {
   const rows = connectionRows(prefix);
   return db.select({ workspace_id: rows.workspace_id, principal_id: rows.principal_id, key: rows.key, client_id: rows.client_id, reason: sql<'revoked' | 'expired'>`CASE WHEN ${rows.disabled_at} IS NOT NULL THEN 'revoked' ELSE 'expired' END` }).from(rows)
    .where(or(and(isNotNull(rows.disabled_at), lt(rows.disabled_at, cutoffSeconds)), and(isNull(rows.disabled_at), lt(rows.expires_at, cutoffSeconds)))).orderBy(sql`COALESCE(${rows.disabled_at}, ${rows.expires_at})`).limit(limit).all();
  },
  /** Delete connection records and their principals (their grants and credentials go with them). At most IN_LIST_MAX at a time. */
  deleteConnections: async (items: Array<{ principal_id: string; key: string }>) => {
   for (const part of inChunks(items)) {
    await db.batch([
     db.delete(settings).where(/* workspace-scope-exempt: a connection record's key holds its principal's unique id; the daily clean-up deletes ended ones in every workspace */ inArray(settings.key, part.map(i => i.key))),
     db.delete(accessPrincipals).where(/* workspace-scope-exempt: the same principals, by unique id */ inArray(accessPrincipals.id, part.map(i => i.principal_id))),
    ]);
   }
  },
  grantsForPrincipal: (id: string) => db.select().from(accessGrants).where(/* workspace-scope-exempt: finite portfolio consent enumerates workspaces */ eq(accessGrants.principal_id, id)).all(),
 };
}
export function accessQueries(dbLike: DbLike, workspaceId: string) {
 const db = getDb(dbLike);
 const principalWhere = (id: string) => and(eq(accessPrincipals.workspace_id, workspaceId), eq(accessPrincipals.id, id));
 return {
  products: {
   list: () => db.select().from(products).where(and(eq(products.workspace_id, workspaceId), isNull(products.archived_at))).all(),
   get: (id: string) => db.select().from(products).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id), isNull(products.archived_at))).get(),
   create: (p: { id: string; name: string }) => db.insert(products).values({ ...p, workspace_id: workspaceId }).run(),
   rename: (id: string, name: string) => db.update(products).set({ name }).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id))).run(),
   archive: (id: string, now: number) => db.update(products).set({ archived_at: now }).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id))).run(),
   mappings: (productId: string) => db.select({ domain_id: domains.id, domain: domains.domain }).from(productDomains).innerJoin(domains, and(eq(domains.id, productDomains.domain_id), eq(domains.workspace_id, workspaceId))).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.product_id, productId))).all(),
   map: (productId: string, domainId: number) => db.insert(productDomains).values({ workspace_id: workspaceId, product_id: productId, domain_id: domainId }).onConflictDoNothing().run(),
   unmap: (productId: string, domainId: number) => db.delete(productDomains).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.product_id, productId), eq(productDomains.domain_id, domainId))).run(),
   domainProducts: (domainId: number) => db.select({ product_id: productDomains.product_id }).from(productDomains).innerJoin(products, and(eq(products.id, productDomains.product_id), eq(products.workspace_id, workspaceId), isNull(products.archived_at))).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.domain_id, domainId))).all(),
  },
  principals: {
   create: (p: { id: string; name: string; kind: 'human' | 'service'; user_id?: string | null }) => db.insert(accessPrincipals).values({ ...p, workspace_id: workspaceId }).run(),
   get: (id: string) => db.select().from(accessPrincipals).where(principalWhere(id)).get(),
   list: () => db.select().from(accessPrincipals).where(eq(accessPrincipals.workspace_id, workspaceId)).all(),
   disable: (id: string, now: number) => db.update(accessPrincipals).set({ disabled_at: now }).where(principalWhere(id)).run(),
  },
  grants: {
   create: (g: typeof accessGrants.$inferInsert) => db.insert(accessGrants).values({ ...g, workspace_id: workspaceId }).run(),
   list: () => db.select().from(accessGrants).where(eq(accessGrants.workspace_id, workspaceId)).all(),
   revoke: (id: string, now: number) => db.update(accessGrants).set({ revoked_at: now }).where(and(eq(accessGrants.workspace_id, workspaceId), eq(accessGrants.id, id))).run(),
  },
  credentials: {
   create: (c: typeof accessCredentials.$inferInsert) => db.insert(accessCredentials).values({ ...c, workspace_id: workspaceId }).run(),
   list: async () => (await db.select().from(accessCredentials).where(eq(accessCredentials.workspace_id, workspaceId)).all()).map(({ key_hash: _, ...safe }) => safe),
   revoke: (id: string, now: number) => db.update(accessCredentials).set({ revoked_at: now }).where(and(eq(accessCredentials.workspace_id, workspaceId), eq(accessCredentials.id, id))).run(),
   touch: (id: string, now: number) => db.update(accessCredentials).set({ last_used_at: now }).where(and(eq(accessCredentials.workspace_id, workspaceId), eq(accessCredentials.id, id))).run(),
  },
 };
}
