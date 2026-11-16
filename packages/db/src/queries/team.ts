import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { accessCredentials, accessGrants, accessPrincipals, apiKeys, invites, memberships, users, type MembershipRole } from '../schema';

export interface TeamMember {
	id: string;
	email: string;
	name: string;
	role: MembershipRole;
	last_login_at: number | null;
	created_at: number;
}

export function teamQueries(db: Db, workspaceId: string) {
	return {
		/** Users who are members of this workspace (no credentials). */
		list(): Promise<TeamMember[]> {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: memberships.role, last_login_at: users.last_login_at, created_at: users.created_at })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.orderBy(users.created_at)
				.all();
		},

		/** A member of this workspace by id (no credentials), or null. */
		getMember(userId: string) {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: memberships.role })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.where(eq(users.id, userId))
				.get()
				.then((r) => r ?? null);
		},

		/** The workspace's owner (else its earliest admin) — the person digests and notices are sent to. */
		firstAdmin() {
			return db
				.select({ id: users.id, email: users.email, name: users.name })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.where(inArray(memberships.role, ['owner', 'admin']))
				.orderBy(sql`CASE ${memberships.role} WHEN 'owner' THEN 0 ELSE 1 END`, memberships.created_at, users.created_at)
				.limit(1)
				.get()
				.then((r) => r ?? null);
		},

		/** Does this workspace have an owner yet? (False means first-run setup is open.) */
		hasOwner(): Promise<boolean> {
			return db
				.select({ x: memberships.user_id })
				.from(memberships)
				.where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.role, 'owner')))
				.limit(1)
				.get()
				.then((r) => !!r);
		},

		/** The user's role in this workspace, or null if they are not a member. */
		roleOf(userId: string): Promise<MembershipRole | null> {
			return db
				.select({ role: memberships.role })
				.from(memberships)
				.where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId)))
				.get()
				.then((r) => r?.role ?? null);
		},

		/**
		 * Make an existing user the workspace's owner iff it has none yet — one statement, so
		 * two concurrent first sign-ups cannot both win. Returns whether this call did.
		 */
		async claimOwnership(userId: string): Promise<boolean> {
			const res = await db.run(sql`INSERT INTO memberships (workspace_id, user_id, role)
				SELECT ${workspaceId}, ${userId}, 'owner'
				WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ${workspaceId} AND role = 'owner')`);
			return ((res as any).meta?.changes ?? (res as any).changes ?? 0) > 0;
		},

		/** Change a member's role in this workspace (the caller has checked who may, and that it is not the owner). Returns whether a row changed. */
		async setRole(userId: string, role: 'admin' | 'member'): Promise<boolean> {
			const res = await db.update(memberships).set({ role }).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId), ne(memberships.role, 'owner'), ne(memberships.role, role))).returning({ u: memberships.user_id }).all();
			return res.length > 0;
		},

		/** Add an existing user to this workspace (no-op if they already belong). */
		addMember(userId: string, role: MembershipRole) {
			return db.insert(memberships).values({ workspace_id: workspaceId, user_id: userId, role }).onConflictDoNothing().run();
		},

		/** Create a user and make them a member of this workspace, atomically. */
		async addUser(u: { id: string; email: string; name: string; password_hash: string | null; role: 'admin' | 'member' }) {
			// The first admin of a workspace becomes its owner.
			let role: MembershipRole = 'member';
			if (u.role === 'admin') {
				const owner = await db.select({ x: memberships.user_id }).from(memberships).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.role, 'owner'))).limit(1).get();
				role = owner ? 'admin' : 'owner';
			}
			await db.batch([db.insert(users).values(u), db.insert(memberships).values({ workspace_id: workspaceId, user_id: u.id, role })]);
		},

		/**
		 * End what a person holds in this workspace: their API keys, and their agent approvals (human access principals with
		 * their grants and credentials). Nothing else of theirs or of the workspace changes.
		 */
		async revokeAccessOf(userId: string, now: number) {
			const principals = db.select({ id: accessPrincipals.id }).from(accessPrincipals).where(and(eq(accessPrincipals.workspace_id, workspaceId), eq(accessPrincipals.user_id, userId), eq(accessPrincipals.kind, 'human')));
			await db.batch([
				db.update(apiKeys).set({ revoked_at: now }).where(and(eq(apiKeys.workspace_id, workspaceId), eq(apiKeys.user_id, userId), isNull(apiKeys.revoked_at))),
				db.update(accessGrants).set({ revoked_at: now }).where(and(eq(accessGrants.workspace_id, workspaceId), isNull(accessGrants.revoked_at), inArray(accessGrants.principal_id, principals))),
				db.update(accessCredentials).set({ revoked_at: now }).where(and(eq(accessCredentials.workspace_id, workspaceId), isNull(accessCredentials.revoked_at), inArray(accessCredentials.principal_id, principals))),
				db.update(accessPrincipals).set({ disabled_at: now }).where(and(eq(accessPrincipals.workspace_id, workspaceId), eq(accessPrincipals.user_id, userId), eq(accessPrincipals.kind, 'human'), isNull(accessPrincipals.disabled_at))),
			]);
		},

		/**
		 * Remove a member from this workspace (removed by an admin; leaving goes through `lifecycle.leave` and `revokeAccessOf`).
		 * Their access here ends at once; they keep their login, their sessions and their other workspaces.
		 */
		async removeMembership(userId: string, now: number) {
			await this.revokeAccessOf(userId, now);
			await db.delete(memberships).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId))).run();
		},

		// ── Invites ───────────────────────────────────────────────
		getInvite(token: string) {
			return db.select().from(invites).where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token))).get().then((r) => r ?? null);
		},

		insertInvite(inv: { token: string; email: string; role: string; invited_by: string; expires_at: number }) {
			return db.insert(invites).values({ ...inv, workspace_id: workspaceId }).run();
		},

		/** Spend an unused invite: one conditional update, so of two simultaneous accepts exactly one wins. */
		async claimInvite(token: string): Promise<boolean> {
			const res = await db
				.update(invites)
				.set({ used_at: sql`unixepoch()` as any })
				.where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token), isNull(invites.used_at), gt(invites.expires_at, sql`unixepoch()`)))
				.returning({ token: invites.token })
				.all();
			return res.length > 0;
		},

		/** Pending (unused, unexpired) invites of this workspace, newest first. */
		listPendingInvites() {
			return db.select().from(invites)
				.where(and(eq(invites.workspace_id, workspaceId), isNull(invites.used_at), gt(invites.expires_at, sql`unixepoch()`)))
				.orderBy(sql`${invites.created_at} DESC`).all();
		},

		/** Revoke a pending invite. False: no such pending invite in this workspace. */
		async revokeInvite(token: string): Promise<boolean> {
			const res = await db.delete(invites).where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token), isNull(invites.used_at))).returning({ token: invites.token }).all();
			return res.length > 0;
		},

		/** Revoke the pending invites for an address except `keep` (the new one replacing them). Returns the revoked invites. */
		async revokePendingFor(email: string, keep: string) {
			return db.delete(invites)
				.where(and(eq(invites.workspace_id, workspaceId), eq(invites.email, email.toLowerCase().trim()), isNull(invites.used_at), ne(invites.token, keep)))
				.returning({ token: invites.token, role: invites.role, invited_by: invites.invited_by }).all();
		},

		/** Revoke every pending invite a user sent (invited_by holds the inviter's email); call when they are removed. */
		revokeInvitesBy(inviterEmail: string) {
			return db.delete(invites).where(and(eq(invites.workspace_id, workspaceId), eq(invites.invited_by, inviterEmail), isNull(invites.used_at))).run();
		},

		markInviteUsed(token: string) {
			return db.update(invites).set({ used_at: sql`unixepoch()` as any }).where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token))).run();
		},
	};
}
