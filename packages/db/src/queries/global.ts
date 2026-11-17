/**
 * Queries on tables that are deliberately NOT workspace-scoped (see GLOBAL_TABLES
 * in schema.ts): credentials lookups, anonymous free-check results, the shared
 * IP cache. Anything here must not return or modify tenant data.
 */
import { and, asc, eq, gt, gte, inArray, isNull, like, lt, sql } from 'drizzle-orm';
import { batchStatements, getDb, type DbLike } from '../client';
import { inChunks } from './in-list';
import { chunkJson, JSON_PARAM_MAX_BYTES } from './report-store';
import { workspaces, authAccounts, authRateLimits, sessions, canaryTokens, checkResults, hostedZones, ipInfo, refreshRotations, users, verifications } from '../schema';

export interface IpInfoRow { ip: string; reverse_dns: string | null; base_domain: string | null; country_code: string | null; org: string | null; asn: string | null; fetched_at: number }

type NewCheckResult = Omit<typeof checkResults.$inferInsert, 'id' | 'created_at'>;

const AGENT_CLIENT_PREFIX = 'agent-client:';
// ';' is the character after ':', so this is every key that starts with the prefix, as a range on the unique index.
const agentClientRange = and(gte(authRateLimits.key, AGENT_CLIENT_PREFIX), lt(authRateLimits.key, 'agent-client;'));

export function globalQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		workspaces: {
			/** Every tenant, for crons that fan out per workspace. */
			create: (id: string, name: string) => db.insert(workspaces).values({ id, name }).run(),
			ids: () => db.select({ id: workspaces.id }).from(workspaces).orderBy(workspaces.created_at).all().then((rows) => rows.map((r) => r.id)),
		},

		users: {
			byEmail: (email: string) => db.select().from(users).where(eq(users.email, email)).get().then((r) => r ?? null),
			byId: (id: string) => db.select().from(users).where(eq(users.id, id)).get().then((r) => r ?? null),
			touchLogin: (userId: string) => db.update(users).set({ last_login_at: sql`unixepoch()` as any }).where(eq(users.id, userId)).run(),
			/** Keep the legacy users.role column in step with the membership role (admin = owner or admin). */
			setLegacyRole: (userId: string, role: 'admin' | 'member') => db.update(users).set({ role }).where(eq(users.id, userId)).run(),
			delete: (userId: string) => db.delete(users).where(eq(users.id, userId)).run(),
			/** Does this user have a password login (as opposed to OAuth only)? */
			hasPassword: (userId: string) =>
				db.select({ id: authAccounts.id }).from(authAccounts).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'credential'), sql`${authAccounts.password} IS NOT NULL AND ${authAccounts.password} <> '!'`)).get().then((r) => !!r),
			/** Make the stored password unusable ('!' never matches a hash): used when a password was chosen before the email was proven. */
			discardPassword: (userId: string) =>
				db.update(authAccounts).set({ password: '!' }).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'credential'))).run(),
			markEmailVerified: (userId: string) => db.update(users).set({ email_verified: 1 }).where(eq(users.id, userId)).run(),
		},

		sessions: {
			/** Sign a user out everywhere. */
			revokeAll: (userId: string) => db.delete(sessions).where(eq(sessions.userId, userId)).run(),
		},

		/** Who a password-reset token (as emailed) belongs to, if it is still valid. */
		verifications: {
			/** A one-hour password-reset token, as the reset email would carry (used to turn email verification into a set-password step). */
			createResetToken: (userId: string, token: string, nowSeconds: number) =>
				db.insert(verifications).values({ id: crypto.randomUUID(), identifier: `reset-password:${token}`, value: userId, expiresAt: new Date((nowSeconds + 3600) * 1000) }).run(),
			resetTokenUser: (token: string, nowSeconds: number) =>
				db
					.select({ userId: verifications.value })
					.from(verifications)
					.where(and(eq(verifications.identifier, `reset-password:${token}`), gt(verifications.expiresAt, new Date(nowSeconds * 1000))))
					.get()
					.then((r) => r?.userId ?? null),
		},

		/**
		 * Count one request against a fixed window and say how many the window holds now.
		 * One statement, so concurrent requests cannot all pass a stale read.
		 * `last_request` is the start of the current window, in ms.
		 */
		rateLimit: {
			hit: (key: string, nowMs: number, windowMs: number) => {
				const expired = sql`${nowMs} - ${authRateLimits.lastRequest} >= ${windowMs}`;
				return db
					.insert(authRateLimits)
					.values({ id: crypto.randomUUID(), key, count: 1, lastRequest: nowMs })
					.onConflictDoUpdate({
						target: authRateLimits.key,
						set: {
							count: sql`CASE WHEN ${expired} THEN 1 ELSE ${authRateLimits.count} + 1 END`,
							lastRequest: sql`CASE WHEN ${expired} THEN ${nowMs} ELSE ${authRateLimits.lastRequest} END`,
						},
					})
					.returning({ count: authRateLimits.count, lastRequest: authRateLimits.lastRequest })
					.get();
			},
			/**
			 * Count one request only if the window has expired or holds fewer than `max`: one conditional statement, so
			 * simultaneous requests cannot all pass a stale read. Returns the new count, or null when refused (nothing counted).
			 */
			hitUnder: async (key: string, nowMs: number, windowMs: number, max: number): Promise<{ count: number; lastRequest: number } | null> => {
				const expired = sql`${nowMs} - ${authRateLimits.lastRequest} >= ${windowMs}`;
				const row = await db
					.insert(authRateLimits)
					.values({ id: crypto.randomUUID(), key, count: 1, lastRequest: nowMs })
					.onConflictDoUpdate({
						target: authRateLimits.key,
						set: {
							count: sql`CASE WHEN ${expired} THEN 1 ELSE ${authRateLimits.count} + 1 END`,
							lastRequest: sql`CASE WHEN ${expired} THEN ${nowMs} ELSE ${authRateLimits.lastRequest} END`,
						},
						setWhere: sql`${expired} OR ${authRateLimits.count} < ${max}`,
					})
					.returning({ count: authRateLimits.count, lastRequest: authRateLimits.lastRequest })
					.get();
				return row ?? null;
			},
			/** The count in the key's current window, without counting a request (null when the window has expired or never started). */
			peek: async (key: string, nowMs: number, windowMs: number): Promise<{ count: number; lastRequest: number } | null> => {
				const row = await db.select({ count: authRateLimits.count, lastRequest: authRateLimits.lastRequest }).from(authRateLimits).where(eq(authRateLimits.key, key)).get();
				return row && nowMs - row.lastRequest < windowMs ? row : null;
			},
			/** Undo one `hitUnder` in the same window (when a later limit refused the request). */
			giveBack: (key: string, windowStart: number) =>
				db.update(authRateLimits).set({ count: sql`${authRateLimits.count} - 1` }).where(and(eq(authRateLimits.key, key), eq(authRateLimits.lastRequest, windowStart), gt(authRateLimits.count, 0))).run(),
			/** Delete expired windows whose key starts with `prefix` (opportunistic cleanup; the rows carry no other data). */
			prune: (prefix: string, olderThanMs: number) =>
				db.delete(authRateLimits).where(and(like(authRateLimits.key, `${prefix}%`), lt(authRateLimits.lastRequest, olderThanMs))).run(),
		},

		/**
		 * Apps that registered themselves and that nobody has approved yet (src/mcp/registration.ts), one row each in the rate-limit table
		 * under `agent-client:<client id>`, with the registration time as `last_request`. A row leaves when the app is approved or deleted, so
		 * what is here is exactly what may be expired or evicted. The key range uses the unique index on `key`.
		 */
		agentClients: {
			/** `nameWithheld` is kept in `count` (2 instead of 1): the app gave a name that was not stored, and the approval page says so while it waits. */
			add: (clientId: string, nowMs: number, nameWithheld = false) =>
				db.insert(authRateLimits).values({ id: crypto.randomUUID(), key: `${AGENT_CLIENT_PREFIX}${clientId}`, count: nameWithheld ? 2 : 1, lastRequest: nowMs }).onConflictDoNothing().run(),
			/** Whether the waiting app gave a name that was withheld (a well-known one). False for an app that gave none, and for one no longer waiting. */
			nameWithheld: (clientId: string) =>
				db.select({ n: authRateLimits.count }).from(authRateLimits).where(eq(authRateLimits.key, `${AGENT_CLIENT_PREFIX}${clientId}`)).get().then((r) => (r?.n ?? 1) > 1),
			/** The app was approved (or deleted): it is no longer a candidate for expiry. */
			remove: async (clientIds: string[]) => {
				for (const part of inChunks(clientIds)) await db.delete(authRateLimits).where(inArray(authRateLimits.key, part.map((c) => `${AGENT_CLIENT_PREFIX}${c}`))).run();
			},
			/** How many are waiting: those registered after `sinceMs` when given (an app past its time is not counted), otherwise all of them. */
			count: (sinceMs?: number) => db.select({ n: sql<number>`COUNT(*)` }).from(authRateLimits).where(sinceMs === undefined ? agentClientRange : and(agentClientRange, gt(authRateLimits.lastRequest, sinceMs))).get().then((r) => r?.n ?? 0),
			/** Oldest first: those registered before `beforeMs` (all of them when omitted), at most `limit`. */
			oldest: async (limit: number, beforeMs?: number): Promise<Array<{ clientId: string; registeredAt: number }>> =>
				(await db.select({ key: authRateLimits.key, at: authRateLimits.lastRequest }).from(authRateLimits).where(beforeMs === undefined ? agentClientRange : and(agentClientRange, lt(authRateLimits.lastRequest, beforeMs))).orderBy(asc(authRateLimits.lastRequest)).limit(limit).all())
					.map((r) => ({ clientId: r.key.slice(AGENT_CLIENT_PREFIX.length), registeredAt: r.at })),
		},

		/**
		 * Agent refresh tokens that were used to get a new one (src/mcp/refresh-replay.ts), by the SHA-256 of the token. Inserting the row is the claim of the
		 * rotation: one request wins it, the others read the winner's answer. Times are milliseconds.
		 */
		refreshRotations: {
			/** Claim the rotation of this token. True for the one request that inserted the row. */
			claim: (tokenHash: string, grantKey: string, nowMs: number) =>
				db.insert(refreshRotations).values({ token_hash: tokenHash, grant_key: grantKey, first_used_at: nowMs, state: 'pending', response: null }).onConflictDoNothing().returning({ h: refreshRotations.token_hash }).all().then((r) => r.length === 1),
			/** Take over a claim that was never finished (its request died): true when this request now holds it. */
			takeOver: (tokenHash: string, nowMs: number, staleBeforeMs: number) =>
				db.update(refreshRotations).set({ first_used_at: nowMs }).where(and(eq(refreshRotations.token_hash, tokenHash), eq(refreshRotations.state, 'pending'), lt(refreshRotations.first_used_at, staleBeforeMs))).returning({ h: refreshRotations.token_hash }).all().then((r) => r.length === 1),
			get: (tokenHash: string) => db.select().from(refreshRotations).where(eq(refreshRotations.token_hash, tokenHash)).get().then((r) => r ?? null),
			/** The rotation finished: keep its answer (already encrypted). */
			finish: (tokenHash: string, response: string) => db.update(refreshRotations).set({ state: 'done', response }).where(eq(refreshRotations.token_hash, tokenHash)).run(),
			/** The rotation failed: the claim is dropped so the same token can try again. */
			release: (tokenHash: string) => db.delete(refreshRotations).where(and(eq(refreshRotations.token_hash, tokenHash), eq(refreshRotations.state, 'pending'))).run(),
			/** Daily clean-up: delete up to `limit` rows first used before `cutoffMs`; returns how many went. */
			purgeBefore: (cutoffMs: number, limit: number) =>
				db.all<{ n: number }>(sql`DELETE FROM refresh_rotations WHERE token_hash IN (SELECT token_hash FROM refresh_rotations WHERE first_used_at < ${cutoffMs} LIMIT ${limit}) RETURNING 1 AS n`).then((r) => r.length),
		},

		checkResults: {
			insert: (r: Omit<NewCheckResult, 'session_token' | 'spf_lookup_count'> & { session_token?: string | null; spf_lookup_count?: number | null }) =>
				db.insert(checkResults).values({ ...r, session_token: r.session_token ?? null, spf_lookup_count: r.spf_lookup_count ?? null }).run(),
			byToken: (token: string) => db.select().from(checkResults).where(eq(checkResults.session_token, token)).get().then((r) => r ?? null),
			/**
			 * The newest check for each of the given domains, at the domain level only: who ran the check (from_email,
			 * session_token) is never part of it. Callers pass only domains their workspace has verified.
			 */
			async latestPerDomain(domains: string[], limit = 20) {
				if (domains.length === 0) return [];
				const rows = await db
					.select({
						id: checkResults.id,
						from_domain: checkResults.from_domain,
						spf_result: checkResults.spf_result,
						spf_domain: checkResults.spf_domain,
						spf_record: checkResults.spf_record,
						dkim_result: checkResults.dkim_result,
						dkim_domain: checkResults.dkim_domain,
						dmarc_result: checkResults.dmarc_result,
						dmarc_policy: checkResults.dmarc_policy,
						dmarc_record: checkResults.dmarc_record,
						overall_status: checkResults.overall_status,
						spf_lookup_count: checkResults.spf_lookup_count,
						created_at: checkResults.created_at,
					})
					.from(checkResults)
					.where(inArray(checkResults.from_domain, domains))
					.orderBy(sql`${checkResults.created_at} DESC`, sql`${checkResults.id} DESC`)
					.limit(500)
					.all();
				const seen = new Set<string>();
				return rows.filter((r) => (seen.has(r.from_domain) ? false : (seen.add(r.from_domain), true))).slice(0, limit);
			},
		},

		/** Record counts of the operator's hosted-records zone(s). */
		hostedZones: {
			get: (zoneKey: string) => db.select().from(hostedZones).where(eq(hostedZones.zone_key, zoneKey)).get().then((r) => r ?? null),
			list: () => db.select().from(hostedZones).all(),
			/** Register a zone, or refresh its Cloudflare id/name; the count is left alone. */
			upsert: (z: { zone_key: string; zone_id: string; zone_name: string }) =>
				db.insert(hostedZones).values(z).onConflictDoUpdate({ target: hostedZones.zone_key, set: { zone_id: sql`excluded.zone_id`, zone_name: sql`excluded.zone_name` } }).run(),
			/** Our own bookkeeping between daily counts: one statement, so concurrent writers do not lose updates. */
			addCount: (zoneKey: string, delta: number) =>
				db.update(hostedZones).set({ record_count: sql`MAX(0, ${hostedZones.record_count} + ${delta})` }).where(eq(hostedZones.zone_key, zoneKey)).run(),
			/** The daily count from Cloudflare itself (every record in the zone). */
			setObserved: (zoneKey: string, recordCount: number, restDigest: string, nowSeconds: number) =>
				db.update(hostedZones).set({ record_count: recordCount, rest_digest: restDigest, checked_at: nowSeconds }).where(eq(hostedZones.zone_key, zoneKey)).run(),
		},

		/** Addresses for the anonymous free check: expiring, single use, hash only. */
		canary: {
			issue: (tokenHash: string, expiresAt: number) => db.insert(canaryTokens).values({ token_hash: tokenHash, expires_at: expiresAt }).run(),
			/** Use a token once. True when it existed, had not expired and had not been used. */
			consume: (tokenHash: string, nowSeconds: number) =>
				db
					.update(canaryTokens)
					.set({ used_at: nowSeconds })
					.where(and(eq(canaryTokens.token_hash, tokenHash), isNull(canaryTokens.used_at), gt(canaryTokens.expires_at, nowSeconds)))
					.returning({ h: canaryTokens.token_hash })
					.all()
					.then((rows) => rows.length > 0),
			purgeExpired: (nowSeconds: number) => db.delete(canaryTokens).where(lt(canaryTokens.expires_at, nowSeconds - 86400)).run(),
		},

		/**
		 * Authenticated senders that are not in the registry, for the instance owner (candidates to add by hand; never promoted automatically).
		 * One row per (DKIM organisation, From, report email, workspace, day): no report content, no customer address.
		 */
		reporterCandidates: {
			note: (c: { dkimOrg: string; from: string; reportEmail: string; orgName: string | null; workspaceId: string; day: string }) =>
				db.run(sql`INSERT INTO reporter_candidate_days (dkim_org, from_address, report_email, workspace_id, day, reports, org_name)
					VALUES (${c.dkimOrg}, ${c.from}, ${c.reportEmail}, ${c.workspaceId}, ${c.day}, 1, ${c.orgName})
					ON CONFLICT(dkim_org, from_address, report_email, workspace_id, day) DO UPDATE SET reports = reports + 1, org_name = excluded.org_name`),
			list: (limit = 200) =>
				db.all<{ dkim_org: string; from_address: string; report_email: string; org_name: string | null; reports: number; workspaces: number; days_seen: number; first_seen: string; last_seen: string }>(sql`
					SELECT dkim_org, from_address, report_email, MAX(org_name) AS org_name, SUM(reports) AS reports, COUNT(DISTINCT workspace_id) AS workspaces,
					       COUNT(DISTINCT day) AS days_seen, MIN(day) AS first_seen, MAX(day) AS last_seen
					FROM reporter_candidate_days GROUP BY dkim_org, from_address, report_email ORDER BY workspaces DESC, days_seen DESC, last_seen DESC LIMIT ${limit}`),
			purge: (cutoffDay: string) => db.run(sql`DELETE FROM reporter_candidate_days WHERE day < ${cutoffDay}`),
		},

		/**
		 * Known reporters whose COUNTED reports were dropped for want of storage (intake_drops), across the instance, for the owner's setup check:
		 * per reporter the FIRST drop time and how many addresses are affected. Only drops seen at or after `sinceSeconds`.
		 */
		drops: {
			since: (sinceSeconds: number) =>
				db.all<{ reporter: string; label: string; first_at: number; domains: number; messages: number }>(sql`
					SELECT reporter, MAX(label) AS label, MIN(first_at) AS first_at, COUNT(*) AS domains, SUM(messages) AS messages
					FROM intake_drops WHERE last_at >= ${sinceSeconds} GROUP BY reporter ORDER BY first_at, reporter`),
		},

		/**
		 * What inbound report mail carried, instance-wide, per day: a counter per kind in intake_quota (scope 'auth:<kind>'), no address.
		 * Kinds: present (an authentication header of the trusted kind), absent (none), foreign (a header, another authserv-id), ok (authenticated).
		 */
		authObservations: {
			note: (kind: 'present' | 'absent' | 'foreign' | 'ok' | 'unconfigured', day: string) =>
				db.run(sql`INSERT INTO intake_quota (scope, day, messages) VALUES (${'auth:' + kind}, ${day}, 1) ON CONFLICT(scope, day) DO UPDATE SET messages = messages + 1`),
			since: (sinceDay: string) =>
				db.all<{ scope: string; messages: number }>(sql`SELECT scope, SUM(messages) AS messages FROM intake_quota WHERE scope LIKE 'auth:%' AND day >= ${sinceDay} GROUP BY scope`),
		},

		/**
		 * Instance-wide counters of the storage and daily caps that stopped mail (reason codes such as `cap_instance_day`), one row per reason and day
		 * in `intake_quota` (scope `cap:<reason>`): no address, no customer. Read by the owner's setup check.
		 */
		capObservations: {
			note: (reason: string, day: string) =>
				db.run(sql`INSERT INTO intake_quota (scope, day, messages) VALUES (${'cap:' + reason}, ${day}, 1) ON CONFLICT(scope, day) DO UPDATE SET messages = messages + 1`),
			since: (sinceDay: string) =>
				db.all<{ scope: string; messages: number }>(sql`SELECT scope, SUM(messages) AS messages FROM intake_quota WHERE scope LIKE 'cap:%' AND day >= ${sinceDay} GROUP BY scope`),
		},

		ipInfo: {
			/** Cached rows for many IPs in ONE D1 query (chunks of json_each, in one batch), whatever their age. */
			getMany: async (ips: readonly string[]): Promise<Map<string, IpInfoRow>> => {
				const out = new Map<string, IpInfoRow>();
				if (!ips.length) return out;
				const stmts = chunkJson(ips, JSON_PARAM_MAX_BYTES).map((c) => sql`SELECT ip, reverse_dns, base_domain, country_code, org, asn, fetched_at FROM ip_info WHERE ip IN (SELECT value FROM json_each(${c}))`);
				for (const r of await batchStatements(db, stmts)) for (const row of (r.results ?? []) as IpInfoRow[]) out.set(row.ip, row);
				return out;
			},
			/** Upsert many rows in ONE D1 query. */
			putMany: async (rows: ReadonlyArray<{ ip: string; reverse_dns: string | null; base_domain: string | null; country_code: string | null; org: string | null; asn: string | null }>): Promise<void> => {
				if (!rows.length) return;
				const stmts = chunkJson(rows.map((r) => [r.ip, r.reverse_dns, r.base_domain, r.country_code, r.org, r.asn])).map((c) => sql`INSERT INTO ip_info (ip, reverse_dns, base_domain, country_code, org, asn, fetched_at)
					SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), unixepoch() FROM json_each(${c}) WHERE true
					ON CONFLICT(ip) DO UPDATE SET reverse_dns = excluded.reverse_dns, base_domain = excluded.base_domain, country_code = excluded.country_code, org = excluded.org, asn = excluded.asn, fetched_at = excluded.fetched_at`);
				await batchStatements(db, stmts);
			},
			get: (ip: string) => db.select().from(ipInfo).where(eq(ipInfo.ip, ip)).get().then((r) => r ?? null),
			upsert: (i: { ip: string; reverse_dns: string | null; base_domain: string | null; country_code: string | null; org: string | null; asn: string | null }) =>
				db
					.insert(ipInfo)
					.values({ ...i, fetched_at: sql`unixepoch()` as any })
					.onConflictDoUpdate({
						target: ipInfo.ip,
						set: {
							reverse_dns: sql`excluded.reverse_dns`,
							base_domain: sql`excluded.base_domain`,
							country_code: sql`excluded.country_code`,
							org: sql`excluded.org`,
							asn: sql`excluded.asn`,
							fetched_at: sql`unixepoch()`,
						},
					})
					.run(),
		},
	};
}
