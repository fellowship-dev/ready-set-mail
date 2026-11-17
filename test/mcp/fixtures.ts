// Rows for the tests of agent connections that run on the in-memory database: a person, and an approved connection in the shape src/mcp/connections.ts writes it
// (a principal, and a settings record `mcp_connection:<principal id>`). Times are unix seconds, as in the record.
import type { DatabaseSync } from 'node:sqlite';

export const addUser = (sqlite: DatabaseSync, id: string) =>
 sqlite.prepare("INSERT OR IGNORE INTO users(id, email, name) VALUES (?, ?, ?)").run(id, `${id}@example.com`, id);

export interface ConnectionFixture {
 principalId: string; clientId: string; userId?: string | null; workspaceId?: string;
 createdAt?: number; expiresAt?: number; revokedAt?: number | null;
}

export function addConnection(sqlite: DatabaseSync, c: ConnectionFixture) {
 const workspaceId = c.workspaceId ?? 'ws_default', createdAt = c.createdAt ?? 1_700_000_000, expiresAt = c.expiresAt ?? createdAt + 7 * 86400;
 if (c.userId) addUser(sqlite, c.userId);
 if (workspaceId !== 'ws_default') sqlite.prepare("INSERT OR IGNORE INTO workspaces(id, name) VALUES (?, ?)").run(workspaceId, workspaceId);
 sqlite.prepare("INSERT INTO access_principals(id, workspace_id, kind, user_id, name, disabled_at, created_at) VALUES (?, ?, 'human', ?, 'app', ?, ?)").run(c.principalId, workspaceId, c.userId ?? null, c.revokedAt ?? null, createdAt);
 sqlite.prepare("INSERT INTO access_grants(id, workspace_id, principal_id, domain, actions, expires_at) VALUES (?, ?, ?, 'example.com', '[\"resources:read\"]', ?)").run(`g-${c.principalId}`, workspaceId, c.principalId, expiresAt);
 sqlite.prepare("INSERT INTO settings(workspace_id, key, value) VALUES (?, ?, ?)").run(workspaceId, `mcp_connection:${c.principalId}`, JSON.stringify({ principalId: c.principalId, userId: c.userId ?? '', workspaceId, clientId: c.clientId, name: 'app', createdAt, expiresAt }));
}
