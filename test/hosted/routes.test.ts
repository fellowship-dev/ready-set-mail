import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

import { call, makeEnv, signupVerified, setupOwner } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { hostedNames } from '../../src/hosted/records';
import { HOSTED_ENV, quiet } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const ZONE = 'zone-h';
const APEX = 'h.readysetmail.com';

async function setup() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const signup = async (email: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    return { token, ws };
  };
  const A = await signup('a@example.com');
  const B = await signup('b@example.com');
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, ?, 'a-corp.com', 'x')").run(A.ws);
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (2, ?, 'b-corp.org', 'x')").run(B.ws);
  const cf = stubCloudflare(new FakeCloudflare({ 'readysetmail.com': { id: ZONE } }));
  cf.doh['a-corp.com'] = ['v=spf1 include:_spf.example.net -all'];
  cf.doh['_spf.example.net'] = ['v=spf1 ip4:192.0.2.0/24 -all'];
  cf.mx['a-corp.com'] = ['10 mx1.mail.example.'];
  return { db, env, rows, A, B, cf };
}

beforeEach(() => quiet());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('/api/domains/:id/hosted', () => {
  it('enable → status → verify → rotate → disable', async () => {
    const t = await setup();
    const key = t.A.token;

    const none = await call(t.env, 'GET', '/api/domains/1/hosted', { key });
    expect(await none.json()).toEqual({ enabled: false });

    const enable = await call(t.env, 'POST', '/api/domains/1/hosted', { key, body: {} });
    expect(enable.status).toBe(201);
    const { hosted, addresses } = await enable.json() as any;
    const names = hostedNames(hosted.hosted_id, APEX);
    expect(addresses.rua).toMatch(/^rua\+[a-z2-7]{32}@rua\.readysetmail\.com$/);
    expect(hosted.records).toEqual({ dmarc: names.dmarc, spf: names.spf, tls_rpt: names.tlsRpt, mta_sts: null });
    expect(t.rows('SELECT workspace_id FROM hosted_domains')).toEqual([{ workspace_id: t.A.ws }]);
    expect(t.rows("SELECT resource_name FROM audit_log WHERE action = 'hosted.enable'")).toEqual([{ resource_name: 'a-corp.com' }]);

    // GET never shows the token again
    const status = await (await call(t.env, 'GET', '/api/domains/1/hosted', { key })).text();
    expect(status).not.toContain(addresses.rua.slice(4, 36));
    expect(JSON.parse(status).pointer_status).toEqual({ dmarc: null, spf: null, mta_sts: null, tls_rpt: null, checked_at: null });

    // the customer adds the CNAMEs; verify sees them
    t.cf.cname['_dmarc.a-corp.com'] = names.dmarc;
    t.cf.doh['a-corp.com'] = [`v=spf1 include:${names.spf} -all`];
    const verified = await (await call(t.env, 'POST', '/api/domains/1/hosted/verify', { key })).json() as any;
    expect(verified.pointer_status).toMatchObject({ dmarc: 'ok', spf: 'ok', mta_sts: null, tls_rpt: 'missing' });
    expect(verified.level_inputs).toEqual({ dmarc_published: true, spf_published: true, mta_sts_published: false });

    const rotated = await call(t.env, 'POST', '/api/domains/1/hosted/rotate-token', { key });
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as any).addresses.rua).not.toBe(addresses.rua);

    expect((await call(t.env, 'DELETE', '/api/domains/1/hosted', { key })).status).toBe(200);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect(t.cf.records.get(ZONE)!.filter(r => r.name.endsWith(`.${APEX}`))).toEqual([]);
  });

  it('serves only the caller’s own domains', async () => {
    const t = await setup();
    for (const [method, path] of [['GET', ''], ['POST', ''], ['DELETE', ''], ['POST', '/verify'], ['POST', '/rotate-token']] as const) {
      const r = await call(t.env, method, `/api/domains/2/hosted${path}`, { key: t.A.token, body: method === 'POST' ? {} : undefined });
      expect(r.status).toBe(404);
    }
    expect(t.cf.calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect((await call(t.env, 'GET', '/api/domains/1/hosted')).status).toBe(401);
  });

  it('GET /api/hosted/statuses: every hosted domain of the caller in one request, the same view as the per-domain status', async () => {
    const t = await setup();
    expect(await (await call(t.env, 'GET', '/api/hosted/statuses', { key: t.A.token })).json()).toEqual({ statuses: {} });
    await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: {} });
    await call(t.env, 'POST', '/api/domains/2/hosted', { key: t.B.token, body: {} });
    const one = await (await call(t.env, 'GET', '/api/domains/1/hosted', { key: t.A.token })).json();
    const all = await (await call(t.env, 'GET', '/api/hosted/statuses', { key: t.A.token })).json() as any;
    expect(all).toEqual({ statuses: { 1: one } });
    expect((await call(t.env, 'GET', '/api/hosted/statuses')).status).toBe(401);
  });

  it('is 404 where hosted mode is off', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { ...HOSTED_ENV, SAAS_ENABLED: '' }) as any;
    expect((await call(env, 'GET', '/api/domains/1/hosted')).status).toBe(503); // MODE=saas without SAAS_ENABLED=1: the whole API is off
  });
});

describe('GET /api/hosted/config', () => {
  it('says the hosted UI applies in hosted mode, to a signed-in caller only', async () => {
    const t = await setup();
    const r = await call(t.env, 'GET', '/api/hosted/config', { key: t.A.token });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: true, reports: true, records: true, mta_sts: false });
    expect((await call(t.env, 'GET', '/api/hosted/config')).status).toBe(401);
  });

  it('says no in self-host, without erroring', async () => {
    const env = makeEnv(createMigratedD1(), {}) as any;
    const key = await setupOwner(env);
    const r = await call(env, 'GET', '/api/hosted/config', { key });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: false, reports: false, records: false, mta_sts: false });
  });

  it('says hosted records are unavailable when no records zone is configured, so no dead "Enable" button is shown', async () => {
    const env = makeEnv(createMigratedD1(), { ...HOSTED_ENV, HOSTED_RECORDS_ZONE: '' }) as any;
    const token = await signupVerified(env, 'a@example.com');
    const r = await call(env, 'GET', '/api/hosted/config', { key: token });
    expect(await r.json()).toEqual({ enabled: true, reports: true, records: false, mta_sts: false });
  });
});

describe('MTA-STS and hosted records (ADR 0015)', () => {
  async function hostedDomain() {
    const t = await setup();
    const { hosted } = await (await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: {} })).json() as any;
    return { ...t, hosted };
  }

  it('asking for MTA-STS with hosted records is refused with the way to turn it on', async () => {
    const t = await setup();
    const res = await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: { mta_sts: true } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/MTA-STS page/);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
  });

  it('a domain with hosted records cannot turn MTA-STS on: its _smtp._tls is already a pointer (409, nothing written)', async () => {
    const t = await hostedDomain();
    const res = await call(t.env, 'POST', '/api/domains/1/mta-sts', { key: t.A.token, body: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'mta_sts_unavailable', reason: 'hosted_records' });
    expect(t.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });

  it('hosted records cannot be enabled over a domain whose MTA-STS is on', async () => {
    const t = await setup();
    t.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts) VALUES (1, 'p', ?, 'mx1.mail.example')").run(t.A.ws);
    const res = await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: {} });
    expect(res.status).toBe(409);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
  });

  it('disabling hosted records keeps the customer\'s own MTA-STS config, and removes a leftover one made by the old hosted MTA-STS', async () => {
    const t = await hostedDomain();
    t.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts) VALUES (1, 'p', ?, 'mx1.mail.example')").run(t.A.ws);
    expect((await call(t.env, 'DELETE', '/api/domains/1/hosted', { key: t.A.token })).status).toBe(200);
    expect(t.rows('SELECT domain_id FROM mta_sts_config')).toHaveLength(1);

    const u = await hostedDomain();
    u.db.sqlite.prepare("UPDATE hosted_domains SET mta_sts_txt_record_id = 'gone'").run();
    u.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts) VALUES (1, 'p', ?, 'mx1.mail.example')").run(u.A.ws);
    expect((await call(u.env, 'DELETE', '/api/domains/1/hosted', { key: u.A.token })).status).toBe(200);
    expect(u.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });
});

describe('domain paths on a hosted domain', () => {
  const hostedWithMtaSts = async () => {
    const t = await setup();
    const { hosted } = await (await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: {} })).json() as any;
    return { ...t, hosted };
  };

  it('deleting a domain removes its hosted records and quota first', async () => {
    const t = await hostedWithMtaSts();
    expect((await call(t.env, 'DELETE', '/api/domains/1', { key: t.A.token })).status).toBeLessThan(300);
    expect(t.cf.records.get(ZONE)!.filter(r => r.name.endsWith(`.${APEX}`))).toEqual([]);
    expect(t.rows('SELECT * FROM domains WHERE id = 1')).toEqual([]);
    expect(t.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: 0 }]);
  });

  it('if the DNS cleanup fails the domain is kept, with its records and rows', async () => {
    const t = await hostedWithMtaSts();
    const inner = t.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'DELETE'
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 })
      : inner(input, init)));
    const res = await call(t.env, 'DELETE', '/api/domains/1', { key: t.A.token });
    expect(res.status).toBe(502);
    expect(t.rows('SELECT id FROM domains WHERE id = 1')).toHaveLength(1);
    expect(t.rows('SELECT * FROM hosted_domains')).toHaveLength(1);
    expect(t.rows('SELECT * FROM intake_tokens WHERE domain_id = 1')).toHaveLength(1);
  });
});
