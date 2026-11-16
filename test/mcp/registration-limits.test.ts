// Open registration's guard rails in workerd: the per-address budget, the whole-instance daily count, the ceiling on stored apps, the daily sweep of apps
// nobody approved, and the audit entry for each of them (ADR 0018).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTRATION_DEFAULTS, registrationLimits, sweepUnusedClients } from '../../src/mcp/registration';
import { makeEnv, type TestDb } from '../auth/helpers';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

const ip = (n: number) => ({ 'cf-connecting-ip': `198.51.100.${n}` });
const meta = (row: { meta: string | null }) => JSON.parse(row.meta ?? '{}');

describe('the daily count and the per-address budget', () => {
 let app: Installation;
 beforeAll(async () => {
  app = await startRuntime({
   bindings: { MCP_DCR_ENABLED: '1', MCP_DCR_DAILY_LIMIT: '3' },
   ratelimits: { AUTH_LIMITER: { namespace_id: '1001', simple: { limit: 4, period: 60 } } },
  });
 }, 60000);
 afterAll(async () => { await app?.dispose(); });

 it('counts only registrations the library accepted: a refused one spends nothing', async () => {
  for (let i = 0; i < 5; i++) expect((await app.register({ ...GOOD, redirect_uris: ['http://example.com/x'] }, ip(10 + i))).status).toBe(400);
  for (let i = 0; i < 3; i++) expect((await app.register(GOOD, ip(20 + i))).status).toBe(201);
 });
 it('refuses the fourth in the day with 429, Retry-After and an OAuth error body, from any address', async () => {
  const r = await app.register(GOOD, ip(30));
  expect(r.status).toBe(429);
  expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(80000);
  expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(86400);
  expect(await r.json()).toMatchObject({ error: 'rate_limited', error_description: expect.stringContaining('today') });
 });
 it('one address gets its own small budget, answered 429 before the daily count is touched', async () => {
  for (let i = 0; i < 4; i++) expect((await app.register({ ...GOOD, client_name: '<b>' }, ip(40))).status).toBe(400);
  const limited = await app.register(GOOD, ip(40));
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('60');
  expect((await limited.json() as { error_description: string }).error_description).toMatch(/from this address/);
 });
 it('audits every registration and refusal at the instance level, with the reason and the redirect host, never an address of the caller', async () => {
  const rows = await app.audit();
  const registered = rows.filter(r => r.action === 'agent.client_registered');
  expect(registered).toHaveLength(3);
  expect(registered[0]).toMatchObject({ resource_name: 'Test assistant', actor_type: 'system', workspace_id: 'ws_default' });
  expect(registered[0]!.resource_id).toMatch(/^[\w-]{16}$/);
  expect(meta(registered[0]!)).toEqual({ redirect_hosts: ['https://client.example'] });
  const refused = rows.filter(r => r.action === 'agent.client_registration_refused');
  expect(refused.map(r => meta(r).reason)).toEqual(expect.arrayContaining(['redirect_uri_rejected', 'name_rejected', 'daily_limit']));
  expect(JSON.stringify(rows)).not.toContain('198.51.100');
 });
});

describe('the ceiling on stored apps', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1', MCP_DCR_MAX_CLIENTS: '2' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 it('answers 503 temporarily_unavailable with Retry-After once the ceiling is reached, and audits it', async () => {
  expect((await app.register()).status).toBe(201);
  expect((await app.register()).status).toBe(201);
  const r = await app.register();
  expect(r.status).toBe(503);
  expect(r.headers.get('retry-after')).toBe('3600');
  expect(await r.json()).toMatchObject({ error: 'temporarily_unavailable' });
  expect((await app.audit()).filter(a => a.action === 'agent.client_registration_refused').map(a => meta(a).reason)).toEqual(['client_cap']);
 });
});

describe('the daily sweep of apps nobody approved', () => {
 let app: Installation;
 const DAY = 86400;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const backdate = async (clientId: string, days: number) => {
  const key = 'client:' + clientId;
  const record = await app.kv.get(key, { type: 'json' }) as Record<string, unknown>;
  await app.kv.put(key, JSON.stringify({ ...record, registrationDate: Math.floor(Date.now() / 1000) - days * DAY }));
 };
 it('deletes an old app that was never approved, keeps one that was, keeps a young one, and audits each deletion', async () => {
  const stale = await app.registerOk({ ...GOOD, client_name: 'Never approved' });
  const approved = await app.registerOk({ ...GOOD, client_name: 'Approved once' });
  const young = await app.registerOk({ ...GOOD, client_name: 'Just registered' });
  const tokens = await app.connect(approved);
  await backdate(stale, 8); await backdate(approved, 30); await backdate(young, 6);
  await (await app.runtime.getWorker()).scheduled({ cron: '0 4 * * *' });
  expect(await app.kv.get('client:' + stale)).toBeNull();
  expect(await app.kv.get('client:' + approved)).not.toBeNull();
  expect(await app.kv.get('client:' + young)).not.toBeNull();
  const expired = (await app.audit()).filter(a => a.action === 'agent.client_expired');
  expect(expired).toHaveLength(1);
  expect(expired[0]).toMatchObject({ resource_id: stale, resource_name: 'Never approved', actor_type: 'system' });
  expect(meta(expired[0]!)).toMatchObject({ unused_days: 7 });
  // the approved app's refresh still works: the sweep did not take its registration
  const refresh = await app.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: approved, refresh_token: tokens.refresh_token, resource: ORIGIN + '/mcp' }).toString() });
  expect(refresh.status, await refresh.clone().text()).toBe(200);
  // a deleted app cannot start a connection: its authorize link gets the page, not a redirect
  const page = await app.fetch('/oauth/authorize?' + app.authorizeQuery(stale), { headers: { cookie: app.cookie } });
  expect(page.status).toBe(400); expect(page.headers.get('location')).toBeNull();
 }, 60000);
});

describe('sweep bounds and settings', () => {
 const clients = (n: number, age: number) => Array.from({ length: n }, (_, i) => ({ clientId: `c${i}`, clientName: `Old ${i}`, registrationDate: age }));
 const fake = (items: ReturnType<typeof clients>) => { const deleted: string[] = []; return { deleted, api: { listClients: async () => ({ items, cursor: undefined }), deleteClient: async (id: string) => { deleted.push(id); } } as never }; };
 it('deletes at most 50 per run and says it stopped early', async () => {
  const env = makeEnv() as never as Parameters<typeof sweepUnusedClients>[0];
  const { api, deleted } = fake(clients(60, 1));
  const result = await sweepUnusedClients(env, api, 1_000_000);
  expect(deleted).toHaveLength(50);
  expect(result).toEqual({ looked: 60, deleted: 50, truncated: true });
 });
 it('keeps an app named by an approved connection in any workspace, and honours MCP_DCR_UNUSED_DAYS', async () => {
  const env = makeEnv(undefined, { MCP_DCR_UNUSED_DAYS: '3' }) as never as Parameters<typeof sweepUnusedClients>[0];
  (env.DB as unknown as TestDb).sqlite.prepare("INSERT INTO workspaces(id,name) VALUES ('ws_two','Two')").run();
  (env.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings(workspace_id,key,value) VALUES ('ws_two','mcp_connection:p1',?), ('ws_two','unrelated',?)").run(JSON.stringify({ clientId: 'c1' }), 'not json');
  const { api, deleted } = fake(clients(3, 1_000_000 - 4 * 86400));
  await sweepUnusedClients(env, api, 1_000_000);
  expect(deleted).toEqual(['c0', 'c2']);
  const young = fake(clients(2, 1_000_000 - 2 * 86400));
  await sweepUnusedClients(env, young.api, 1_000_000);
  expect(young.deleted).toEqual([]);
 });
 it('reads its settings with defaults, ignoring nonsense', () => {
  expect(registrationLimits({})).toEqual(REGISTRATION_DEFAULTS);
  expect(REGISTRATION_DEFAULTS).toEqual({ dailyLimit: 200, maxClients: 1000, unusedDays: 7 });
  expect(registrationLimits({ MCP_DCR_DAILY_LIMIT: '25', MCP_DCR_MAX_CLIENTS: '0', MCP_DCR_UNUSED_DAYS: 'soon' })).toEqual({ dailyLimit: 25, maxClients: 1000, unusedDays: 7 });
 });
});
