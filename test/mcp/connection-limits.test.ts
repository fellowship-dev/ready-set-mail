// How many apps a person, a workspace and the instance may keep connected, and the clean-up of ended connections (ADR 0022).
// One account cannot use up the room that registration needs for everyone else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVAL_LIMITS, approvalLimitReached, CONNECTION_RETENTION_DAYS, LIMIT_SENTENCES, sweepEndedConnections } from '../../src/mcp/connection-limits';
import { makeEnv, type TestDb } from '../auth/helpers';
import { addConnection, addUser } from './fixtures';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 10, 16, 12) / 1000);
const worldWithKv = () => {
 const store = new Map<string, string>();
 const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } };
 const env = makeEnv(undefined, { OAUTH_KV: kv }) as never as Parameters<typeof sweepEndedConnections>[0];
 return { env, store, sqlite: (env.DB as unknown as TestDb).sqlite };
};
const rows = (sqlite: ReturnType<typeof worldWithKv>['sqlite'], table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('what one person, one workspace and one day allow (simulated)', () => {
 it('the numbers, and the sentence for each says what the limit is and what to do, with no jargon', () => {
  expect(APPROVAL_LIMITS).toEqual({ perPerson: 20, perWorkspace: 50, perPersonPerDay: 20 });
  expect(LIMIT_SENTENCES.person).toContain('revoke one you no longer use');
  expect(LIMIT_SENTENCES.workspace).toContain('choose another workspace');
  expect(LIMIT_SENTENCES.day).toContain('Try again tomorrow');
  for (const sentence of Object.values(LIMIT_SENTENCES)) expect(sentence).not.toMatch(/\b(429|OAuth|grant|principal|token|scope)\b/i);
 });

 it('20 live apps stop the 21st; revoking one lets the person go on', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 20; i++) addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, userId: 'u1', createdAt: NOW - 3 * DAY });
  expect(await approvalLimitReached(w.env, 'u1', [], NOW)).toBe('person');
  w.sqlite.prepare("UPDATE access_principals SET disabled_at = ? WHERE id = 'p0'").run(NOW);
  expect(await approvalLimitReached(w.env, 'u1', [], NOW)).toBeNull();
 });

 it('an approve-and-revoke loop by one person stops at 20 approvals in 24 hours, whatever they revoke, and is free again a day later', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 20; i++) addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, userId: 'u1', createdAt: NOW - 3600 + i, revokedAt: NOW - 3000 + i });
  expect(await approvalLimitReached(w.env, 'u1', [], NOW)).toBe('day');
  expect(await approvalLimitReached(w.env, 'u1', [], NOW + DAY - 3600 + 19)).toBeNull();
 });

 it('another person is not touched by the first one reaching a limit, and nor is a workspace the first never used', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 20; i++) addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, userId: 'u1', createdAt: NOW - 100, workspaceId: 'ws_one' });
  addUser(w.sqlite, 'u2');
  expect(await approvalLimitReached(w.env, 'u1', ['ws_one'], NOW)).toBe('person');
  expect(await approvalLimitReached(w.env, 'u2', ['ws_other'], NOW)).toBeNull();
  expect(await approvalLimitReached(w.env, 'u2', [], NOW)).toBeNull();
 });

 it('50 live apps in a workspace, from several people, stop the next one there and only there', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 50; i++) addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, userId: `u${i % 5}`, createdAt: NOW - 3 * DAY, workspaceId: 'ws_full' });
  expect(await approvalLimitReached(w.env, 'u9', ['ws_full'], NOW)).toBe('workspace');
  expect(await approvalLimitReached(w.env, 'u9', ['ws_default'], NOW)).toBeNull();
  // an ended connection of that workspace gives its place back
  w.sqlite.prepare("UPDATE access_principals SET disabled_at = ? WHERE id = 'p3'").run(NOW);
  expect(await approvalLimitReached(w.env, 'u9', ['ws_full'], NOW)).toBeNull();
 });
});

describe('the clean-up of ended connections (simulated)', () => {
 const RETENTION = CONNECTION_RETENTION_DAYS * DAY;
 it('keeps an ended connection for a week, then deletes its record and principal (its grants go with it) and writes it to the audit log', async () => {
  const w = worldWithKv();
  addConnection(w.sqlite, { principalId: 'revoked-old', clientId: 'a1', userId: 'u1', createdAt: NOW - 20 * DAY, revokedAt: NOW - RETENTION - 10 });
  addConnection(w.sqlite, { principalId: 'revoked-new', clientId: 'a2', userId: 'u1', createdAt: NOW - 20 * DAY, revokedAt: NOW - RETENTION + 3600 });
  addConnection(w.sqlite, { principalId: 'expired-old', clientId: 'a3', userId: 'u1', createdAt: NOW - 30 * DAY, expiresAt: NOW - RETENTION - 10 });
  addConnection(w.sqlite, { principalId: 'expired-new', clientId: 'a4', userId: 'u1', createdAt: NOW - 30 * DAY, expiresAt: NOW - RETENTION + 3600 });
  addConnection(w.sqlite, { principalId: 'live', clientId: 'a5', userId: 'u1', createdAt: NOW - DAY });
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) w.store.set(`client:${id}`, '{}');
  const result = await sweepEndedConnections(w.env, NOW * 1000);
  expect(result).toEqual({ removed: 2, appsDeleted: 2, truncated: false });
  const left = (w.sqlite.prepare("SELECT id FROM access_principals ORDER BY id").all() as Array<{ id: string }>).map(r => r.id);
  expect(left).toEqual(['expired-new', 'live', 'revoked-new']);
  expect((w.sqlite.prepare("SELECT key FROM settings WHERE key LIKE 'mcp_connection:%' ORDER BY key").all() as Array<{ key: string }>).map(r => r.key)).toEqual(['mcp_connection:expired-new', 'mcp_connection:live', 'mcp_connection:revoked-new']);
  expect(rows(w.sqlite, 'access_grants')).toBe(3);
  expect([...w.store.keys()].sort()).toEqual(['client:a2', 'client:a4', 'client:a5']);
  const audit = w.sqlite.prepare("SELECT action, resource_id, meta FROM audit_log WHERE action = 'agent.connection_removed' ORDER BY resource_id").all() as Array<{ action: string; resource_id: string; meta: string }>;
  expect(audit.map(a => a.resource_id)).toEqual(['expired-old', 'revoked-old']);
  expect(JSON.parse(audit[0]!.meta)).toEqual({ reason: 'expired', client_id: 'a3', app_deleted: true });
 });

 it('keeps the registered app while another connection of it remains, and never touches an app that has a client document', async () => {
  const w = worldWithKv();
  addConnection(w.sqlite, { principalId: 'old', clientId: 'shared', userId: 'u1', createdAt: NOW - 30 * DAY, revokedAt: NOW - RETENTION - 10 });
  addConnection(w.sqlite, { principalId: 'still', clientId: 'shared', userId: 'u2', createdAt: NOW - DAY });
  addConnection(w.sqlite, { principalId: 'doc', clientId: 'https://claude.ai/client.json', userId: 'u1', createdAt: NOW - 30 * DAY, revokedAt: NOW - RETENTION - 10 });
  w.store.set('client:shared', '{}'); w.store.set('client:https://claude.ai/client.json', 'must stay: it is not ours to delete');
  expect(await sweepEndedConnections(w.env, NOW * 1000)).toMatchObject({ removed: 2, appsDeleted: 0 });
  expect([...w.store.keys()].sort()).toEqual(['client:https://claude.ai/client.json', 'client:shared']);
 });

 it('clears a backlog of any size in batches (D1 binds at most 100 values per statement), within a bounded run', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 250; i++) { addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, userId: 'u1', createdAt: NOW - 30 * DAY, revokedAt: NOW - RETENTION - 10 - i }); w.store.set(`client:c${i}`, '{}'); }
  const first = await sweepEndedConnections(w.env, NOW * 1000);
  expect(first).toEqual({ removed: 200, appsDeleted: 200, truncated: true });
  const second = await sweepEndedConnections(w.env, NOW * 1000);
  expect(second).toEqual({ removed: 50, appsDeleted: 50, truncated: false });
  expect(rows(w.sqlite, 'access_principals')).toBe(0);
  expect(w.store.size).toBe(0);
 });

 it('a run that is out of time stops and says so', async () => {
  const w = worldWithKv();
  for (let i = 0; i < 120; i++) addConnection(w.sqlite, { principalId: `p${i}`, clientId: `c${i}`, createdAt: NOW - 30 * DAY, revokedAt: NOW - RETENTION - 10 });
  let ticks = 0;
  const result = await sweepEndedConnections(w.env, NOW * 1000, () => (ticks++ === 0 ? 0 : 60_000));
  expect(result.truncated).toBe(true);
  expect(rows(w.sqlite, 'access_principals')).toBeGreaterThan(0);
 });
});

describe('one account that approves and revokes over and over (workerd)', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1', MCP_DCR_MAX_CLIENTS: '3' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const revoke = (principalId: string) => app.fetch(`/api/mcp/connections/${principalId}`, { method: 'DELETE', headers: { cookie: app.cookie, origin: ORIGIN } });

 it('hits the day limit with a plain sentence, leaves the ceiling free for everyone else, and the ended ones are deleted after the retention', async () => {
  const id = await app.registerOk();
  for (let i = 0; i < APPROVAL_LIMITS.perPersonPerDay; i++) {
   await app.connect(id);
   const mine = (await app.connections()).find(c => !c.revoked)!;
   expect((await revoke(mine.principalId)).status).toBe(200);
  }
  // revoked apps do not count toward the ceiling of 3: other registrations still get in (they wait, and the oldest waiting one makes room)
  for (let i = 0; i < 5; i++) expect((await app.register(GOOD)).status, `registration ${i}`).toBe(201);
  // the 21st approval in 24 hours: the page says so, before the form, and nothing was shared
  const page = await app.fetch('/oauth/authorize?' + app.authorizeQuery(id), { headers: { cookie: app.cookie } });
  expect(page.status).toBe(429);
  const html = await page.text();
  expect(html).toContain('You have approved 20 apps in the last 24 hours');
  expect(html).toContain('Try again tomorrow.');
  expect(html).not.toContain('name="handle"');
  expect((await app.audit()).filter(a => a.action === 'agent.approval_limit_reached').map(a => JSON.parse(a.meta ?? '{}').limit)).toEqual(['day']);
  expect((await app.audit('agent.connection_approved'))).toHaveLength(20);
  expect((await app.audit('agent.connection_revoked'))).toHaveLength(20);
  // a week later the ended records go, and a new day opens the limit
  await app.db.prepare("UPDATE access_principals SET disabled_at = disabled_at - ?").bind(8 * DAY).run();
  await app.db.prepare("UPDATE settings SET value = json_set(value, '$.createdAt', json_extract(value, '$.createdAt') - ?) WHERE key LIKE 'mcp_connection:%'").bind(8 * DAY).run();
  await (await app.runtime.getWorker()).scheduled({ cron: '0 4 * * *' });
  expect(await app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'mcp_connection:%'").first()).toEqual({ n: 0 });
  expect(await app.kv.get('client:' + id)).toBeNull();
  expect((await app.audit('agent.connection_removed')).length).toBe(20);
 }, 240000);
});
