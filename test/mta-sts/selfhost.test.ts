// Self-host: the same path with the Worker's own host as the policy host (a proxied CNAME in the same Cloudflare account), no operator zone, no gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import worker from '../../src/index';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';
import { refreshMtaStsForTenant } from '../../src/mta-sts/refresh';
import { runCronForWorkspaces } from '../../src/cron';
import { loadTenant } from '../../src/tenancy/load';
import { quietLogs } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function selfHost(opts: { token?: string; reports?: boolean } = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { CLOUDFLARE_API_TOKEN: opts.token ?? 'cf-token', WORKER_NAME: 'rsm-worker' }) as any;
  const key = await setupOwner(env);
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, verified_via) VALUES (1, 'acme.com', 'rua@reports.acme.com', 'legacy'), (2, 'unmanaged.net', 'x', 'legacy')").run();
  seedSettings(db, { ...(opts.reports === false ? {} : { base_domain: 'acme.com', reports_domain: 'reports.acme.com' }), zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  const cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } }));
  cf.mx['acme.com'] = ['10 mx.acme.com.'];
  cf.routes['zone-acme'] = [{ pattern: 'inbox.acme.com/*', script: 'rsm-worker' }];
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mta = (method: string, id = 1, body?: unknown, sub = '') => call(env, method, `/api/domains/${id}/mta-sts${sub}`, { key, body });
  return { db, env, key, cf, rows, mta };
}

describe('self-host', () => {
  it('enable: a proxied CNAME to the Worker host, TLS-RPT to the reports domain, the id published at once, no operator calls', async () => {
    const w = await selfHost();
    const before = await (await w.mta('GET')).json() as any;
    expect(before).toMatchObject({ available: true, via: 'cloudflare', policy_host: 'worker_route', unavailable_reason: 'none' });
    expect(before.records[0]).toMatchObject({ value: 'inbox.acme.com', proxied: true });
    const res = await w.mta('POST');
    expect(res.status).toBe(201);
    const recs = w.cf.records.get('zone-acme')!;
    expect(recs.map((r) => `${r.type} ${r.name}`).sort()).toEqual(['CNAME mta-sts.acme.com', 'TXT _mta-sts.acme.com', 'TXT _smtp._tls.acme.com']);
    expect(recs.find((r) => r.type === 'CNAME')!.content).toBe('inbox.acme.com');
    expect(recs.find((r) => r.name === '_smtp._tls.acme.com')!.content).toBe('v=TLSRPTv1; rua=mailto:tls-rpt@reports.acme.com');
    expect(w.cf.calls.find((c) => c.method === 'POST' && c.body?.type === 'CNAME')!.body).toMatchObject({ proxied: true });
    expect(w.rows('SELECT state, via, policy_host, mode, ch_id, route_id FROM mta_sts_config')).toEqual([{ state: 'active', via: 'cloudflare', policy_host: 'worker_route', mode: 'testing', ch_id: null, route_id: null }]);
    expect(w.cf.calls.some((c) => c.url.includes('custom_hostnames'))).toBe(false);
  });

  it('serves the policy on mta-sts.<domain> and nothing else (self-host\'s own workspace)', async () => {
    const w = await selfHost();
    await w.mta('POST');
    const ok = await worker.fetch(new Request('https://mta-sts.acme.com/.well-known/mta-sts.txt'), w.env, ctx);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('version: STSv1\nmode: testing\nmx: mx.acme.com\nmax_age: 86400\n');
    expect((await worker.fetch(new Request('https://mta-sts.acme.com/'), w.env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request('https://mta-sts.acme.com/api/domains'), w.env, ctx)).status).toBe(404);
  });

  it('no Cloudflare connection reaching the zone: unavailable, one true sentence (manual is not possible without a certificate path)', async () => {
    const w = await selfHost({ token: '' });
    expect(await (await w.mta('GET')).json()).toMatchObject({ available: false, unavailable_reason: 'needs_cloudflare', via: null });
    const post = await w.mta('POST');
    expect(post.status).toBe(400);
    expect(await post.json()).toMatchObject({ code: 'cloudflare_not_connected', reason: 'needs_cloudflare' });
    const unmanaged = await selfHost();
    expect(await (await unmanaged.mta('GET', 2)).json()).toMatchObject({ available: false, unavailable_reason: 'needs_cloudflare' });
  });

  it('no reports domain: unavailable, and says why', async () => {
    const w = await selfHost({ reports: false });
    expect(await (await w.mta('GET')).json()).toMatchObject({ available: false, unavailable_reason: 'reports_domain_missing' });
  });

  it('refuses a domain that already has MTA-STS elsewhere instead of overwriting it', async () => {
    const w = await selfHost();
    w.cf.doh['_mta-sts.acme.com'] = ['v=STSv1; id=1'];
    const res = await w.mta('POST');
    expect(res.status).toBe(409);
    expect(w.cf.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the 08:00 job refreshes self-host rows; a changed MX list updates the id and the record', async () => {
    const w = await selfHost();
    await w.mta('POST');
    const old = w.rows('SELECT policy_id FROM mta_sts_config')[0].policy_id;
    w.cf.mx['acme.com'] = ['10 mx.acme.com.', '20 mx2.acme.com.'];
    await runCronForWorkspaces({ cron: '0 8 * * *' } as ScheduledController, w.env, ctx, { workspaces: ['ws_default'] });
    const row = w.rows('SELECT policy_id, mx_hosts FROM mta_sts_config')[0];
    expect(row.mx_hosts).toBe('mx.acme.com,mx2.acme.com');
    expect(row.policy_id).not.toBe(old);
    expect(w.cf.records.get('zone-acme')!.find((r) => r.name === '_mta-sts.acme.com')!.content).toBe(`v=STSv1; id=${row.policy_id}`);
    // nothing changed → nothing written
    const calls = w.cf.calls.length;
    const tenant = await loadTenant(w.env, { workspaceId: 'ws_default' });
    expect(await refreshMtaStsForTenant(tenant)).toMatchObject({ visited: 1, changed: 0 });
    expect(w.cf.calls.slice(calls).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('rows from before this release (no state, no via) keep working and are refreshed', async () => {
    const w = await selfHost();
    w.cf.seed('zone-acme', { id: 'old-txt', type: 'TXT', name: '_mta-sts.acme.com', content: 'v=STSv1; id=1' });
    w.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, mode, mx_hosts, policy_id, mta_sts_record_id, workspace_id) VALUES (1, 'enforce', 'old.acme.com', '1', 'old-txt', 'ws_default')").run();
    const view = await (await w.mta('GET')).json() as any;
    expect(view.config).toMatchObject({ state: 'active', via: 'cloudflare', policy_host: 'worker_route', mode: 'enforce', max_age: 86400 });
    w.cf.mx['acme.com'] = ['10 mx.acme.com.'];
    const res = await w.mta('PATCH', 1, { refresh_mx: true });
    expect(res.status).toBe(200);
    expect((await res.json() as any).mode).toBe('testing'); // grew while enforcing
    expect(w.cf.records.get('zone-acme')!.find((r) => r.id === 'old-txt')!.content).toMatch(/^v=STSv1; id=\d{14}a?$/);
  });
});
