// Open registration's guard rails (ADR 0015): the per-address and whole-instance daily budgets, the ceiling on stored apps, how long an app nobody approved
// is kept, the clean-up that keeps the store from filling, and the audit entry for each of them. The first half runs in workerd, the second simulates days.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetApprovedClient, handleRegistration, REGISTRATION_DEFAULTS, registrationLimits, sweepUnusedClients } from '../../src/mcp/registration';
import { addressKey } from '../../src/mcp/rate-limit';
import { makeEnv, type TestDb } from '../auth/helpers';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

const ip = (n: number) => ({ 'cf-connecting-ip': `198.51.100.${n}` });
const meta = (row: { meta: string | null }) => JSON.parse(row.meta ?? '{}');

describe('the daily budgets, per address and for the instance (workerd)', () => {
 let app: Installation;
 beforeAll(async () => {
  app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1', MCP_DCR_DAILY_LIMIT: '5', MCP_DCR_ADDRESS_DAILY_LIMIT: '2' } });
 }, 60000);
 afterAll(async () => { await app?.dispose(); });

 it('counts only registrations the library accepted: a refused one spends nothing', async () => {
  for (let i = 0; i < 3; i++) expect((await app.register({ ...GOOD, redirect_uris: ['http://example.com/x'] }, ip(10))).status).toBe(400);
  expect((await app.register(GOOD, ip(10))).status).toBe(201);
  expect((await app.register(GOOD, ip(10))).status).toBe(201);
 });
 it('one address that used its day gets 429 with Retry-After and an OAuth error body, and another address still registers', async () => {
  const mine = await app.register(GOOD, ip(10));
  expect(mine.status).toBe(429);
  expect(Number(mine.headers.get('retry-after'))).toBeGreaterThan(80000);
  expect(await mine.json()).toMatchObject({ error: 'rate_limited', error_description: expect.stringContaining('This address') });
  expect((await app.register(GOOD, ip(11))).status).toBe(201);
 });
 it('the refused address spent none of the instance budget: 3 of 5 are used, not 6', async () => {
  const row = await app.db.prepare("SELECT count FROM auth_rate_limits WHERE key = 'oauth-register:day'").first() as { count: number };
  expect(row.count).toBe(3);
 });
 it('when the instance budget is used up, every address is refused for the rest of the day, and an address that was refused keeps its own count', async () => {
  expect((await app.register(GOOD, ip(12))).status).toBe(201);
  expect((await app.register(GOOD, ip(12))).status).toBe(201);
  const r = await app.register(GOOD, ip(13));
  expect(r.status).toBe(429);
  expect(await r.json()).toMatchObject({ error_description: expect.stringContaining('This server') });
  const own = await app.db.prepare("SELECT count FROM auth_rate_limits WHERE key = 'oauth-register:day:198.51.100.13'").first() as { count: number };
  expect(own.count).toBe(0);
 });
 it('audits every registration and refusal at the instance level, with the reason and the redirect host, never an address of the caller', async () => {
  const rows = await app.audit();
  const registered = rows.filter(r => r.action === 'agent.client_registered');
  expect(registered).toHaveLength(5);
  expect(registered[0]).toMatchObject({ actor_type: 'system', workspace_id: 'ws_default' });
  expect(registered[0]!.resource_id).toMatch(/^[\w-]{16}$/);
  expect(meta(registered[0]!)).toEqual({ redirect_hosts: ['https://client.example'] });
  const refused = rows.filter(r => r.action === 'agent.client_registration_refused');
  expect(refused.map(r => meta(r).reason)).toEqual(expect.arrayContaining(['redirect_uri_rejected', 'address_daily_limit', 'daily_limit']));
  expect(JSON.stringify(rows)).not.toContain('198.51.100');
 });
});

describe('the ceiling and the clean-up (workerd)', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1', MCP_DCR_MAX_CLIENTS: '2' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const stored = async () => (await app.kv.list({ prefix: 'client:' })).keys.length;
 it('at the ceiling the oldest app nobody approved makes room, so registration is not refused', async () => {
  const first = await app.registerOk(); await app.registerOk();
  expect(await stored()).toBe(2);
  const third = await app.registerOk();
  expect(await stored()).toBe(2);
  expect(await app.kv.get('client:' + first)).toBeNull();
  expect(await app.kv.get('client:' + third)).not.toBeNull();
  expect((await app.audit()).filter(a => a.action === 'agent.client_evicted')).toHaveLength(1);
 });
 it('only when every stored app is approved is it refused: 503 with Retry-After, audited', async () => {
  for (const { clientId } of (await app.db.prepare("SELECT substr(key, 14) AS clientId FROM auth_rate_limits WHERE key LIKE 'agent-client:%'").all()).results as Array<{ clientId: string }>) {
   await app.connect(clientId);
  }
  expect(await app.db.prepare("SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key LIKE 'agent-client:%'").first()).toEqual({ n: 0 });
  const r = await app.register();
  expect(r.status).toBe(503);
  expect(r.headers.get('retry-after')).toBe('3600');
  expect(await r.json()).toMatchObject({ error: 'temporarily_unavailable' });
  expect((await app.audit()).filter(a => a.action === 'agent.client_registration_refused').map(a => meta(a).reason)).toContain('client_cap');
 }, 60000);
});

describe('the clean-up at the lifecycle job (workerd)', () => {
 let app: Installation;
 const HOUR = 3_600_000;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const age = (clientId: string, hours: number) => app.db.prepare('UPDATE auth_rate_limits SET last_request = ? WHERE key = ?').bind(Date.now() - hours * HOUR, 'agent-client:' + clientId).run();
 it('deletes an app nobody approved after 24 hours, keeps one that was approved and one that is young, and audits each deletion', async () => {
  const stale = await app.registerOk({ ...GOOD, client_name: 'Never approved' });
  const approved = await app.registerOk({ ...GOOD, client_name: 'Approved once' });
  const young = await app.registerOk({ ...GOOD, client_name: 'Just registered' });
  const tokens = await app.connect(approved);
  await age(stale, 25); await age(young, 23);
  await (await app.runtime.getWorker()).scheduled({ cron: '0 4 * * *' });
  expect(await app.kv.get('client:' + stale)).toBeNull();
  expect(await app.kv.get('client:' + approved)).not.toBeNull();
  expect(await app.kv.get('client:' + young)).not.toBeNull();
  const expired = (await app.audit()).filter(a => a.action === 'agent.client_expired');
  expect(expired).toHaveLength(1);
  expect(expired[0]).toMatchObject({ resource_id: stale, actor_type: 'system' });
  expect(meta(expired[0]!)).toMatchObject({ unused_hours: 24 });
  // the approved app's refresh still works: the clean-up did not take its registration
  const refresh = await app.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: approved, refresh_token: tokens.refresh_token, resource: ORIGIN + '/mcp' }).toString() });
  expect(refresh.status, await refresh.clone().text()).toBe(200);
  // a deleted app cannot start a connection: its authorize link gets the page, not a redirect
  const page = await app.fetch('/oauth/authorize?' + app.authorizeQuery(stale), { headers: { cookie: app.cookie } });
  expect(page.status).toBe(400); expect(page.headers.get('location')).toBeNull();
 }, 60000);
 it('the generic rate-limit sweep leaves a waiting app alone, however old: only its own clean-up deletes it, together with the app', async () => {
  const waiting = await app.registerOk();
  await app.db.prepare('UPDATE auth_rate_limits SET last_request = 1 WHERE key = ?').bind('agent-client:' + waiting).run();
  const { sweepExpiredRateLimits } = await import('../../src/auth/rate-limit');
  await sweepExpiredRateLimits(app.db as never);
  expect(await app.db.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key = ?').bind('agent-client:' + waiting).first()).toEqual({ n: 1 });
 });
});

// ── Simulated days: handleRegistration and the job take the clock, and the OAuth library is replaced by a store that keeps what it is given. ──

type Kv = { store: Map<string, string>; get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void>; delete(k: string): Promise<void> };
const kv = (): Kv => { const store = new Map<string, string>(); return { store, get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } }; };
const DAY = 86_400_000;
const world = (extra: Record<string, unknown> = {}) => {
 const store = kv();
 const env = makeEnv(undefined, { OAUTH_KV: store, ...extra }) as never as Parameters<typeof handleRegistration>[1];
 let n = 0;
 const forward = async (request: Request) => {
  const body = await request.json() as Record<string, unknown>;
  const client_id = `app${++n}`;
  store.store.set('client:' + client_id, JSON.stringify(body));
  return Response.json({ client_id, ...body }, { status: 201 });
 };
 const register = (address: string, now: number) => handleRegistration(new Request(ORIGIN + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': address }, body: JSON.stringify(GOOD) }), env, undefined, forward, now);
 const clients = () => [...store.store.keys()].filter(k => k.startsWith('client:')).length;
 return { env, store, register, clients, sqlite: (env.DB as unknown as TestDb).sqlite };
};
const T0 = Date.UTC(2026, 10, 16);

describe('one address cannot block another (simulated)', () => {
 it('an address that registers over and over is stopped at 20 a day and has spent at most 20 of the instance budget; every other address registers all day', async () => {
  const w = world();
  let refused = 0;
  for (let i = 0; i < 500; i++) if ((await w.register('203.0.113.1', T0 + i * 1000)).status !== 201) refused++;
  expect(refused).toBe(480);
  expect(w.sqlite.prepare("SELECT count FROM auth_rate_limits WHERE key = 'oauth-register:day'").get()).toEqual({ count: 20 });
  for (let i = 0; i < 100; i++) expect((await w.register(`203.0.113.${10 + i}`, T0 + 600_000 + i)).status, `address ${i}`).toBe(201);
 });
 it('an address gets a new day after 24 hours', async () => {
  const w = world();
  for (let i = 0; i < 20; i++) await w.register('203.0.113.1', T0 + i);
  expect((await w.register('203.0.113.1', T0 + 1000)).status).toBe(429);
  expect((await w.register('203.0.113.1', T0 + DAY + 1)).status).toBe(201);
 });
 it('rotating through the addresses of one IPv6 block does not buy new budgets', async () => {
  const w = world();
  const a = (n: number) => `2001:db8:1:2:${n.toString(16)}::1`;
  const results = [];
  for (let i = 0; i < 30; i++) results.push((await w.register(a(i + 1), T0 + i)).status);
  expect(results.filter(s => s === 201)).toHaveLength(20);
  expect((await w.register('2001:db8:1:3::1', T0 + 100)).status).toBe(201);
 });
 it('the key of an address: IPv4 as it is, IPv6 as its /64, a mapped IPv4 as the IPv4', () => {
  const key = (ipaddr: string) => addressKey(new Request(ORIGIN, { headers: { 'cf-connecting-ip': ipaddr } }));
  expect(key('203.0.113.7')).toBe('203.0.113.7');
  expect(key('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  expect(key('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(key('::ffff:203.0.113.7')).toBe('203.0.113.7');
  expect(addressKey(new Request(ORIGIN))).toBe('unknown');
 });
});

describe('the store cannot fill and stay full (simulated)', () => {
 it('over four days at the most the limits allow, apps nobody approves leave as fast as they come, and registration is never refused for room', async () => {
  const w = world({ MCP_DCR_DAILY_LIMIT: '2000' });
  let peak = 0, refusedForRoom = 0;
  for (let day = 0; day < 4; day++) {
   // 100 addresses a day, each at its 20-a-day limit: 2,000 registrations, the whole instance budget, spread over the day.
   for (let i = 0; i < 2000; i++) {
    const r = await w.register(`198.51.${Math.floor(i / 20) % 250}.${Math.floor(i / 20) % 250 + 1}`, T0 + day * DAY + i * 40_000);
    if (r.status === 503) refusedForRoom++;
   }
   const end = T0 + day * DAY + DAY - 1;
   await sweepUnusedClients(w.env, end);
   peak = Math.max(peak, w.clients());
  }
  expect(refusedForRoom).toBe(0);
  // After each daily job only the last 24 hours are left: at most one day's inflow, never four days' worth.
  expect(peak).toBeLessThanOrEqual(2000);
  expect(w.clients()).toBeLessThanOrEqual(2000);
 }, 120000);

 it('a flood of unapproved apps from many addresses at the ceiling evicts the oldest instead of refusing, and the store stays at the ceiling', async () => {
  const w = world({ MCP_DCR_MAX_CLIENTS: '50', MCP_DCR_ADDRESS_DAILY_LIMIT: '1000', MCP_DCR_DAILY_LIMIT: '100000' });
  for (let i = 0; i < 300; i++) expect((await w.register(`192.0.2.${i % 250}`, T0 + i * 1000)).status, `registration ${i}`).toBe(201);
  expect(w.clients()).toBeLessThanOrEqual(50);
  expect(w.clients()).toBeGreaterThanOrEqual(40);
 });

 it('approved apps are never evicted or expired; when every stored app is approved the answer is 503, and the job leaves them alone', async () => {
  const w = world({ MCP_DCR_MAX_CLIENTS: '5', MCP_DCR_ADDRESS_DAILY_LIMIT: '1000' });
  for (let i = 0; i < 5; i++) await w.register(`192.0.2.${i}`, T0 + i);
  for (let i = 1; i <= 5; i++) {
   w.sqlite.prepare("INSERT INTO settings(workspace_id,key,value) VALUES ('ws_default',?,?)").run(`mcp_connection:p${i}`, JSON.stringify({ clientId: `app${i}` }));
   await forgetApprovedClient(w.env, `app${i}`);
  }
  expect((await w.register('192.0.2.99', T0 + 10_000)).status).toBe(503);
  await sweepUnusedClients(w.env, T0 + 10 * DAY);
  expect(w.clients()).toBe(5);
 });

 it('each registration deletes up to ten expired apps first, and the job takes them all, however many and however old, oldest first', async () => {
  const w = world({ MCP_DCR_ADDRESS_DAILY_LIMIT: '100000', MCP_DCR_DAILY_LIMIT: '100000' });
  for (let i = 0; i < 1500; i++) await w.register(`10.0.${Math.floor(i / 250)}.${i % 250}`, T0 + i);
  expect(w.clients()).toBe(1500);
  await w.register('192.0.2.1', T0 + 2 * DAY);
  expect(w.clients()).toBe(1500 - 10 + 1);
  const first = await sweepUnusedClients(w.env, T0 + 2 * DAY);
  expect(first).toMatchObject({ deleted: 800, truncated: true });
  expect(first.remaining).toBeGreaterThan(0);
  const second = await sweepUnusedClients(w.env, T0 + 2 * DAY);
  expect(second.truncated).toBe(false);
  expect(second.remaining).toBe(0);
  expect(w.clients()).toBe(1);
 }, 60000);

 it('a run that is out of time stops and says so', async () => {
  const w = world({ MCP_DCR_ADDRESS_DAILY_LIMIT: '100000', MCP_DCR_DAILY_LIMIT: '100000' });
  for (let i = 0; i < 300; i++) await w.register(`10.1.0.${i % 250}`, T0 + i);
  let ticks = 0;
  const result = await sweepUnusedClients(w.env, T0 + 2 * DAY, () => (ticks++ === 0 ? 0 : 60_000));
  expect(result.truncated).toBe(true);
  expect(result.remaining).toBeGreaterThan(0);
 });

 it('a registry row left by an approval is healed, not deleted with a live app', async () => {
  const w = world();
  await w.register('192.0.2.1', T0);
  w.sqlite.prepare("INSERT INTO settings(workspace_id,key,value) VALUES ('ws_default','mcp_connection:p1',?)").run(JSON.stringify({ clientId: 'app1' }));
  await sweepUnusedClients(w.env, T0 + 2 * DAY);
  expect(w.store.store.has('client:app1')).toBe(true);
  expect(w.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key LIKE 'agent-client:%'").get()).toEqual({ n: 0 });
 });
});

describe('settings', () => {
 it('reads its settings with defaults, ignoring nonsense', () => {
  expect(registrationLimits({})).toEqual(REGISTRATION_DEFAULTS);
  expect(REGISTRATION_DEFAULTS).toEqual({ dailyLimit: 2000, addressDailyLimit: 20, maxClients: 5000, unusedHours: 24 });
  expect(registrationLimits({ MCP_DCR_DAILY_LIMIT: '25', MCP_DCR_ADDRESS_DAILY_LIMIT: '3', MCP_DCR_MAX_CLIENTS: '0', MCP_DCR_UNUSED_HOURS: 'soon' })).toEqual({ dailyLimit: 25, addressDailyLimit: 3, maxClients: 5000, unusedHours: 24 });
 });
 it('one address cannot use more than 1% of the instance budget (the basis of the two numbers)', () => {
  expect(REGISTRATION_DEFAULTS.addressDailyLimit / REGISTRATION_DEFAULTS.dailyLimit).toBeLessThanOrEqual(0.01);
 });
});
