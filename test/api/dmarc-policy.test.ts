import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

// PATCH /api/domains/:id/dmarc changes p= of the live _dmarc.{domain} record in the domain's own zone, keeps every other
// tag, and never touches the report authorization record whose id is domains.dns_record_id.

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;

const ZONES = {
  'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' },
  'other-company.org': { id: 'zone-other', cfAccountId: 'cf-acct' },
};
const AUTH_CONTENT = 'v=DMARC1;';
const RICH = 'v=DMARC1; p=none; pct=50; sp=quarantine; adkim=s; aspf=r; fo=1; ruf=mailto:forensic@vendor.test; ri=3600; rua=mailto:dmarc@vendor.test,mailto:rua@reports.acme.com; x-custom=1';

type Db = ReturnType<typeof createMigratedD1>;
let db: Db;
let cf: FakeCloudflare;

function makeEnv(domains: { id: number; domain: string; dns_record_id?: string | null; rua?: string; policy?: string }[]): Env {
  db = createMigratedD1();
  for (const d of domains) {
    db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id, dmarc_policy) VALUES (?, ?, ?, ?, ?)')
      .run(d.id, d.domain, d.rua ?? 'rua@reports.acme.com', d.dns_record_id ?? null, d.policy ?? 'none');
  }
  seedSettings(db, {
    base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com',
    zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct',
  });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
}

const patch = (id: number, policy: string) => new Request(`https://x.test/api/domains/${id}/dmarc`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
  body: JSON.stringify({ policy }),
});

async function call(id: number, policy: string, env: Env) {
  const res = await handleApi(patch(id, policy), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: res.status, body: (await res.json()) as any };
}

const storedPolicy = (id: number) => (db.sqlite.prepare('SELECT dmarc_policy FROM domains WHERE id = ?').get(id) as { dmarc_policy: string }).dmarc_policy;
const audits = () => db.sqlite.prepare("SELECT before_value, after_value FROM audit_log WHERE action = 'domain.dmarc_mode_change'").all() as { before_value: string; after_value: string }[];
const content = (zone: string, name: string) => (cf.records.get(zone) ?? []).filter(r => r.name === name).map(r => r.content);

beforeEach(() => {
  cf = stubCloudflare(new FakeCloudflare({ ...ZONES }));
  pending.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('PATCH /api/domains/:id/dmarc', () => {
  it('different zones: patches _dmarc.<domain> in its own zone and leaves the authorization record alone', async () => {
    const auth = cf.seed('zone-acme', { type: 'TXT', name: 'other-company.org._report._dmarc.reports.acme.com', content: AUTH_CONTENT });
    cf.seed('zone-other', { type: 'TXT', name: '_dmarc.other-company.org', content: `"${RICH}"` });
    const env = makeEnv([{ id: 2, domain: 'other-company.org', dns_record_id: auth.id }]);

    const r = await call(2, 'reject', env);

    expect(r.status).toBe(200);
    const expected = RICH.replace('p=none', 'p=reject');
    expect(r.body).toEqual({ ok: true, policy: 'reject', record: expected, previous_record: RICH, created: false });
    expect(content('zone-other', '_dmarc.other-company.org')).toEqual([expected]);
    expect(auth.content).toBe(AUTH_CONTENT);
    expect(cf.calls.filter(c => c.method !== 'GET' && c.url.includes(auth.id))).toHaveLength(0);
    expect(storedPolicy(2)).toBe('reject');
    const [a] = audits();
    expect(JSON.parse(a.before_value)).toEqual({ policy: 'none', record: RICH });
    expect(JSON.parse(a.after_value)).toMatchObject({ policy: 'reject', record: expected });
  });

  it('same zone: changes _dmarc.<domain>, never the authorization record', async () => {
    const auth = cf.seed('zone-acme', { type: 'TXT', name: 'acme.com._report._dmarc.reports.acme.com', content: AUTH_CONTENT });
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none; rua=mailto:rua@reports.acme.com' });
    const env = makeEnv([{ id: 1, domain: 'acme.com', dns_record_id: auth.id }]);

    const r = await call(1, 'quarantine', env);

    expect(r.status).toBe(200);
    expect(content('zone-acme', '_dmarc.acme.com')).toEqual(['v=DMARC1; p=quarantine; rua=mailto:rua@reports.acme.com']);
    expect(content('zone-acme', 'acme.com._report._dmarc.reports.acme.com')).toEqual([AUTH_CONTENT]);
  });

  it('works for a domain without an authorization record, and creates the record when none exists', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com', dns_record_id: null }]);
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'google-site-verification=abc' }); // not a DMARC record
    const r = await call(1, 'quarantine', env);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: true, record: 'v=DMARC1; p=quarantine; rua=mailto:rua@reports.acme.com', previous_record: null });
    expect(content('zone-acme', '_dmarc.acme.com')).toEqual(['google-site-verification=abc', 'v=DMARC1; p=quarantine; rua=mailto:rua@reports.acme.com']);
  });

  it('never writes an empty rua=, drops one left by the old route, and keeps third-party addresses', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none; rua=mailto:' });
    let r = await call(1, 'quarantine', makeEnv([{ id: 1, domain: 'acme.com', rua: '' }]));
    expect(r.status).toBe(200);
    expect(r.body.record).toBe('v=DMARC1; p=quarantine');
    expect(content('zone-acme', '_dmarc.acme.com')).toEqual(['v=DMARC1; p=quarantine']);

    cf = stubCloudflare(new FakeCloudflare({ ...ZONES }));
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none; rua=mailto:a@vendor.test,mailto:,mailto:b@other.test' });
    r = await call(1, 'reject', makeEnv([{ id: 1, domain: 'acme.com', rua: '' }]));
    expect(r.body.record).toBe('v=DMARC1; p=reject; rua=mailto:a@vendor.test,mailto:b@other.test');

    cf = stubCloudflare(new FakeCloudflare({ ...ZONES }));
    r = await call(1, 'none', makeEnv([{ id: 1, domain: 'acme.com', rua: '' }]));
    expect(r.body.record).toBe('v=DMARC1; p=none');
  });

  it('adds our report address when the record lacks it, without dropping the others', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none; rua=mailto:dmarc@vendor.test' });
    const r = await call(1, 'quarantine', makeEnv([{ id: 1, domain: 'acme.com' }]));
    expect(r.body.record).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@vendor.test,mailto:rua@reports.acme.com');
  });

  it('refuses (409) when the name has several DMARC records: nothing written, nothing stored or audited', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' });
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=reject' });
    const r = await call(1, 'quarantine', makeEnv([{ id: 1, domain: 'acme.com' }]));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/_dmarc\.acme\.com has 2 DMARC records/);
    expect(cf.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(storedPolicy(1)).toBe('none');
    expect(audits()).toHaveLength(0);
  });

  it('refuses (409) when the live record cannot be read safely', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none; adkim=x' });
    const r = await call(1, 'reject', makeEnv([{ id: 1, domain: 'acme.com' }]));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cannot be updated safely: adkim=x is not a valid value/);
    expect(cf.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(storedPolicy(1)).toBe('none');
  });

  it('stores and audits nothing when the DNS write fails', async () => {
    cf.seed('zone-other', { type: 'TXT', name: '_dmarc.other-company.org', content: 'v=DMARC1; p=none' });
    const env = makeEnv([{ id: 2, domain: 'other-company.org', dns_record_id: 'auth-elsewhere' }]);
    const realFetch = cf.fetch.getMockImplementation()!;
    cf.fetch.mockImplementation(async (input: any, init?: RequestInit) => (init?.method === 'PATCH'
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'CF says no' }] }), { status: 400 })
      : realFetch(input, init)));
    const r = await call(2, 'reject', env);
    expect(r.status).toBe(500);
    expect(storedPolicy(2)).toBe('none');
    expect(audits()).toHaveLength(0);
  });

  it('400s for a bad policy and 404s for an unknown domain', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    expect((await call(1, 'monitor', env)).status).toBe(400);
    expect((await call(9, 'reject', env)).status).toBe(404);
    expect(cf.calls).toHaveLength(0);
  });
});
