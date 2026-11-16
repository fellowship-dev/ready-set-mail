// /api/domains/:id/mta-sts on a hosted instance, through the real router, with a fake Cloudflare for the customer's zones AND the operator's.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../src/index';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { INTAKE, OP, OP_ZONE, mtaWorld, quietLogs } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const policyReq = (host: string, path = '/.well-known/mta-sts.txt', method = 'GET') => new Request(`https://${host}${path}`, { method });

describe('the bug: a hosted workspace with Cloudflare connected can turn MTA-STS on', () => {
  it('POST answers 201 and testing, never "connect Cloudflare first"', async () => {
    const w = await mtaWorld();
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBe(201);
    const body = await w.json(res);
    expect(body).toMatchObject({ ok: true, mode: 'testing', mx_hosts: ['mx.a-corp.com'], via: 'cloudflare', policy_host: 'saas_hostname', config: { state: 'waiting_certificate', mode: 'testing' } });
  });
});

describe('via Cloudflare: the order of work', () => {
  it('registers the policy host, writes the CNAME (DNS only) and TLS-RPT through the connection, and keeps the _mta-sts TXT back until the certificate is active', async () => {
    const w = await mtaWorld();
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBe(201);

    // The operator's zone: one custom hostname and one route, with the operator's token only.
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([expect.objectContaining({ hostname: 'mta-sts.a-corp.com', status: 'pending' })]);
    expect(w.cf.routes[OP_ZONE]).toEqual([expect.objectContaining({ pattern: 'mta-sts.a-corp.com/*', script: 'rsm-worker' })]);
    expect(w.calls(OP_ZONE).every((c) => c.auth === `Bearer ${OP.token}`)).toBe(true);
    expect(w.writes(OP_ZONE).map((c) => `${c.method} ${c.url.split('/zones/')[1].replace(OP_ZONE, 'Z')}`)).toEqual(['POST Z/custom_hostnames', 'POST Z/workers/routes']);

    // The customer's zone: exactly the CNAME (DNS only, to the operator's target) and the TLS-RPT TXT.
    const customer = w.cf.records.get(w.Z.a1)!;
    expect(customer.map((r) => `${r.type} ${r.name}`).sort()).toEqual(['CNAME mta-sts.a-corp.com', 'TXT _smtp._tls.a-corp.com']);
    expect(customer.find((r) => r.type === 'CNAME')!.content).toBe(OP.target);
    expect(w.writes(w.Z.a1).find((c) => c.body?.type === 'CNAME')!.body).toMatchObject({ proxied: false });
    expect(customer.find((r) => r.type === 'TXT')!.content).toBe(`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`);

    expect(w.row(1)).toMatchObject({ state: 'waiting_certificate', via: 'cloudflare', policy_host: 'saas_hostname', mode: 'testing', mx_hosts: 'mx.a-corp.com', mta_sts_record_id: null, policy_published_at: null, workspace_id: w.A.ws });
    expect(w.row(1).ch_id).toBeTruthy();
    expect(w.row(1).route_id).toBeTruthy();
    expect(w.rows("SELECT action FROM audit_log WHERE action IN ('mta_sts.enable')")).toHaveLength(1);
  });

  it('verify: pending while the certificate is, then publishes the id LAST and the row is active', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    w.cf.cname['mta-sts.a-corp.com'] = OP.target;
    w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];

    const pending = await w.json(await w.mta(w.A.token, 'POST', 1, undefined, '/verify'));
    expect(pending).toMatchObject({ ok: true, state: 'waiting_certificate' });
    expect(pending.checks.map((c: any) => [c.key, c.state])).toEqual([['policy_host', 'ok'], ['certificate', 'pending'], ['tls_rpt', 'ok'], ['policy_id', 'missing']]);
    expect(w.cf.records.get(w.Z.a1)!.some((r) => r.name === '_mta-sts.a-corp.com')).toBe(false);

    w.cf.activateHostname('mta-sts.a-corp.com');
    const done = await w.json(await w.mta(w.A.token, 'POST', 1, undefined, '/verify'));
    expect(done.state).toBe('active');
    const txt = w.cf.records.get(w.Z.a1)!.find((r) => r.name === '_mta-sts.a-corp.com')!;
    expect(txt.content).toBe(`v=STSv1; id=${w.row(1).policy_id}`);
    expect(w.row(1)).toMatchObject({ state: 'active', ch_status: 'active', ch_ssl_status: 'active', mta_sts_record_id: txt.id });
    expect(w.row(1).policy_published_at).toBeGreaterThan(0);
    // the TXT is the last record written
    const order = w.writes(w.Z.a1).map((c) => c.body?.name);
    expect(order.at(-1)).toBe('_mta-sts.a-corp.com');
  });

  it('serves the policy (testing, the MX hosts, max_age from the row, never cached) and nothing else on the policy host', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    const res = await worker.fetch(policyReq('mta-sts.a-corp.com'), w.env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('version: STSv1\nmode: testing\nmx: mx.a-corp.com\nmax_age: 86400\n');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect((await worker.fetch(policyReq('mta-sts.a-corp.com', '/.well-known/mta-sts.txt', 'HEAD'), w.env, ctx)).status).toBe(200);
    for (const [path, method] of [['/', 'GET'], ['/index.html', 'GET'], ['/api/domains', 'GET'], ['/health', 'GET'], ['/assets/app.js', 'GET'], ['/.well-known/mta-sts.txt', 'POST'], ['/.well-known/mta-sts.txt/', 'GET']] as const) {
      const r = await worker.fetch(policyReq('mta-sts.a-corp.com', path, method), w.env, ctx);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('serves 404 for a domain nobody owns, another workspace\'s domain without MTA-STS, and an unproven one', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    expect((await worker.fetch(policyReq('mta-sts.nobody.example'), w.env, ctx)).status).toBe(404);
    expect((await worker.fetch(policyReq('mta-sts.b-corp.org'), w.env, ctx)).status).toBe(404);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy', proof_lost_at = 1700000000 WHERE id = 1").run();
    expect((await worker.fetch(policyReq('mta-sts.a-corp.com'), w.env, ctx)).status).toBe(404);
  });

  it('GET before enable shows what will happen: via, the MX hosts, the exact records', async () => {
    const w = await mtaWorld();
    const body = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(body).toMatchObject({
      available: true, unavailable_reason: 'none', unavailable_message: null, via: 'cloudflare', policy_host: 'saas_hostname', config: null,
      mx_preview: { status: 'ok', hosts: ['mx.a-corp.com'], error: null }, max_age: 86400, reports: [], summary: null, enforce: null, disable: null,
    });
    expect(body.records).toEqual([
      expect.objectContaining({ purpose: 'policy_host', type: 'CNAME', name: 'mta-sts.a-corp.com', value: OP.target, proxied: false, written: false }),
      expect.objectContaining({ purpose: 'tls_rpt', type: 'TXT', name: '_smtp._tls.a-corp.com', value: `v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}` }),
      expect.objectContaining({ purpose: 'policy_id', type: 'TXT', name: '_mta-sts.a-corp.com', value: 'v=STSv1; id=YYYYMMDDHHMMSS' }),
    ]);
    expect(w.writes(OP_ZONE)).toEqual([]);
  });
});

describe('by hand (no connection reaches the zone)', () => {
  it('registers the policy host, writes nothing at the customer, and walks the person through records → certificate → id', async () => {
    const w = await mtaWorld();
    const before = await w.json(await w.mta(w.A.token, 'GET', 2));
    expect(before).toMatchObject({ available: true, via: 'manual', policy_host: 'saas_hostname' });

    const res = await w.mta(w.A.token, 'POST', 2);
    expect(res.status).toBe(201);
    const body = await w.json(res);
    expect(body).toMatchObject({ via: 'manual', config: { state: 'waiting_records' } });
    expect(body.records.filter((r: any) => r.add_now).map((r: any) => r.purpose)).toEqual(['policy_host', 'tls_rpt']);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(w.writes(w.Z.a2)).toEqual([]);
    expect(w.cf.records.get(w.Z.a2)).toBeUndefined();

    const check = async () => w.json(await w.mta(w.A.token, 'POST', 2, undefined, '/verify'));
    expect((await check()).state).toBe('waiting_records');

    w.cf.cname['mta-sts.a-two.org'] = OP.target;
    w.cf.doh['_smtp._tls.a-two.org'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
    expect((await check()).state).toBe('waiting_certificate');

    w.cf.activateHostname('mta-sts.a-two.org');
    const waitingTxt = await check();
    expect(waitingTxt.state).toBe('waiting_txt');
    const view = await w.json(await w.mta(w.A.token, 'GET', 2));
    expect(view.records.find((r: any) => r.purpose === 'policy_id')).toMatchObject({ add_now: true, value: `v=STSv1; id=${w.row(2).policy_id}`, written: false });

    w.cf.doh['_mta-sts.a-two.org'] = [`v=STSv1; id=${w.row(2).policy_id}`];
    const active = await check();
    expect(active.state).toBe('active');
    expect(w.row(2).policy_published_at).toBeGreaterThan(0);
    expect(w.writes(w.Z.a2)).toEqual([]); // still nothing written at the customer
  });

  it('a wrong record is said, not accepted', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 2);
    w.cf.cname['mta-sts.a-two.org'] = 'somewhere.else.example';
    w.cf.doh['_smtp._tls.a-two.org'] = ['v=TLSRPTv1; rua=mailto:someone@else.example'];
    const out = await w.json(await w.mta(w.A.token, 'POST', 2, undefined, '/verify'));
    expect(out.state).toBe('waiting_records');
    expect(out.checks.find((c: any) => c.key === 'policy_host')).toMatchObject({ state: 'wrong', detail: `mta-sts.a-two.org points at somewhere.else.example, not ${OP.target}.` });
    expect(out.checks.find((c: any) => c.key === 'tls_rpt')).toMatchObject({ state: 'wrong' });
  });
});

describe('GET with TLS reports', () => {
  it('lists the reports of the last 30 days with their MTA-STS sessions and failure types, and totals them', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    const day = 86400;
    const t = Math.floor(Date.now() / 1000);
    const ins = w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run('Google', t - 2 * day, t - day, 50, 4, 45, 3, '["certificate-expired"]', w.A.ws);
    ins.run('Microsoft', t - 3 * day, t - 2 * day, 10, 0, null, null, null, w.A.ws); // stored before the MTA-STS sessions were kept
    ins.run('Old', t - 40 * day, t - 39 * day, 99, 0, 99, 0, '[]', w.A.ws);
    const body = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(body.reports.map((r: any) => r.reporter)).toEqual(['Google', 'Microsoft']);
    expect(body.reports[0]).toMatchObject({ successful_sessions: 50, failed_sessions: 4, sts_successful_sessions: 45, sts_failed_sessions: 3, failure_types: ['certificate-expired'], period_start: t - 2 * day, period_end: t - day });
    expect(body.reports[1]).toMatchObject({ sts_successful_sessions: null, sts_failed_sessions: null, failure_types: [] });
    expect(body.summary).toEqual({ total_success: 60, total_failure: 4, report_count: 2, sts_success: 45, sts_failure: 3 });
    expect(body.enforce).toMatchObject({ allowed: false });
    expect(body.enforce.reasons.join(' ')).toMatch(/Setup is not finished/);
    expect(body.disable).toEqual({ allowed: true, after: null, reason: null });
    expect(body).toMatchObject({ policy_host_status: { kind: 'saas_hostname', hostname: 'mta-sts.a-corp.com', route: true, certificate: { status: 'pending', ssl_status: 'pending_validation', active: false } } });
  });
});

describe('GET /api/hosted/config', () => {
  it('says whether MTA-STS can be served, never a secret', async () => {
    const w = await mtaWorld();
    const res = await w.api(w.A.token, 'GET', '/api/hosted/config');
    expect(await res.json()).toMatchObject({ enabled: true, reports: true, mta_sts: true });
    expect(JSON.stringify(await w.json(await w.api(w.A.token, 'GET', '/api/hosted/config')))).not.toContain(OP.token);
    const off = await mtaWorld({ POLICY_HOST_TOKEN: '' });
    expect(await (await off.api(off.A.token, 'GET', '/api/hosted/config')).json()).toMatchObject({ mta_sts: false });
  });
});

describe('the health report\'s TLS history', () => {
  it('says the sessions under the MTA-STS policy once MTA-STS is on and serving, and its old totals otherwise', async () => {
    const w = await mtaWorld();
    const t = Math.floor(Date.now() / 1000);
    const ins = w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id) VALUES (1, 'Google', ?, ?, 50, 4, 45, 3, '[]', ?)");
    ins.run(t - 2 * 86400, t - 86400, w.A.ws);
    const tls = async () => (await w.json(await w.api(w.A.token, 'GET', '/api/domains/1/health-report'))).sections.tls;
    expect((await tls()).data).toMatchObject({ total_success: 50, total_failure: 4, mta_sts: null });
    await w.mta(w.A.token, 'POST', 1);
    expect((await tls()).data.mta_sts).toBeNull(); // set up is not finished: not on yet
    w.db.sqlite.prepare("UPDATE mta_sts_config SET state = 'active' WHERE domain_id = 1").run();
    expect((await tls()).data).toMatchObject({ sts_success: 45, sts_failure: 3, mta_sts: { mode: 'testing' } });
  });
});
