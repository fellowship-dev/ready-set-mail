import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { FakeCloudflare } from '../helpers/cf-fake';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { for (const m of ['warn', 'log', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const Z = 'e1'.repeat(16);
const AUTH_NAME = 'other.org._report._dmarc.reports.home.com';

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { CLOUDFLARE_API_TOKEN: 'env-tok-0123456789' }) as any;
  const owner = await setupOwner(env);
  const cf = new FakeCloudflare({ 'home.com': { id: Z, cfAccountId: 'cf-1' }, 'other.org': { id: 'e2'.repeat(16), cfAccountId: 'cf-1' } });
  cf.accounts = [{ id: 'cf-1', name: 'Home' }];
  cf.mx['other.org'] = ['10 mx.other.org.'];
  cf.routes[Z] = [{ pattern: 'inbox.home.com/*', script: 'ready-set-mail-worker' }];
  vi.stubGlobal('fetch', cf.fetch);
  const insert = db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, dns_record_id) VALUES (?, 'ws_default', ?, 'rua@x', ?)");
  const auth = cf.seed(Z, { type: 'TXT', name: AUTH_NAME, content: 'v=DMARC1;' });
  db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'reports_domain', 'reports.home.com')").run();
  insert.run(1, 'home.com', null);
  insert.run(2, 'other.org', auth.id);
  const api = (method: string, path: string, body?: unknown) => call(env, method, path, { key: owner, body });
  const audit = () => (db.sqlite.prepare('SELECT action, resource_name, after_value FROM audit_log ORDER BY id').all() as any[]);
  return { db, cf, auth, api, audit };
}

describe('removing a domain whose report-authorisation record the customer changed', () => {
  it('still removes the domain, says which record was kept and why, and audits dns.kept (never dns.delete)', async () => {
    const w = await world();
    w.cf.records.get(Z)![0].content = 'v=DMARC1; rua=mailto:me@example.net';
    const res = await w.api('DELETE', '/api/domains/2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kept: [{ type: 'TXT', name: AUTH_NAME, reason: 'its content no longer matches what Ready Set Mail wrote' }] });
    expect(w.cf.records.get(Z)).toHaveLength(1);
    expect(w.db.sqlite.prepare('SELECT id FROM domains WHERE id = 2').all()).toEqual([]);
    await new Promise(r => setTimeout(r, 20));
    const actions = w.audit().map(a => a.action);
    expect(actions).toContain('dns.kept');
    expect(actions).not.toContain('dns.delete');
  });

  it('an unchanged record is deleted: dns.delete, nothing kept', async () => {
    const w = await world();
    const res = await w.api('DELETE', '/api/domains/2');
    expect(await res.json()).toEqual({ ok: true, kept: [] });
    expect(w.cf.records.get(Z)).toEqual([]);
    await new Promise(r => setTimeout(r, 20));
    expect(w.audit().filter(a => a.resource_name === AUTH_NAME).map(a => a.action)).toEqual(['dns.delete']);
  });

  it('a record that is already gone (404): dns.already_gone, nothing kept', async () => {
    const w = await world();
    w.cf.records.set(Z, []);
    const res = await w.api('DELETE', '/api/domains/2');
    expect(await res.json()).toEqual({ ok: true, kept: [] });
    await new Promise(r => setTimeout(r, 20));
    expect(w.audit().filter(a => a.resource_name === AUTH_NAME).map(a => a.action)).toEqual(['dns.already_gone']);
  });
});

describe('disabling MTA-STS when the customer changed a record', () => {
  async function enabled() {
    const w = await world();
    const a = w.cf.seed('e2'.repeat(16), { type: 'TXT', name: '_mta-sts.other.org', content: 'v=STSv1; id=1' });
    const b = w.cf.seed('e2'.repeat(16), { type: 'TXT', name: '_smtp._tls.other.org', content: 'v=TLSRPTv1; rua=mailto:tls-rpt@reports.home.com' });
    const c = w.cf.seed('e2'.repeat(16), { type: 'CNAME', name: 'mta-sts.other.org', content: 'w.example.workers.dev' });
    w.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, mode, mx_hosts, policy_id, mta_sts_record_id, tls_rpt_record_id, cname_record_id, workspace_id) VALUES (2, 'testing', 'mx.other.org', '1', ?, ?, ?, 'ws_default')").run(a.id, b.id, c.id);
    return { ...w, a };
  }

  it('deletes the other two, reports the kept one, audits dns.kept for it and dns.delete only for the two deleted', async () => {
    const w = await enabled();
    w.cf.records.get('e2'.repeat(16))!.find(r => r.id === w.a.id)!.content = 'something the customer wrote';
    const res = await w.api('DELETE', '/api/domains/2/mta-sts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kept: [{ type: 'TXT', name: '_mta-sts.other.org', reason: 'its content no longer matches what Ready Set Mail wrote' }] });
    expect(w.cf.records.get('e2'.repeat(16))!.map(r => r.name)).toEqual(['_mta-sts.other.org']);
    await new Promise(r => setTimeout(r, 20));
    const dns = w.audit().filter(a => a.action.startsWith('dns.'));
    expect(dns.filter(a => a.action === 'dns.delete').map(a => a.resource_name).sort()).toEqual(['_smtp._tls.other.org', 'mta-sts.other.org']);
    expect(dns.filter(a => a.action === 'dns.kept').map(a => a.resource_name)).toEqual(['_mta-sts.other.org']);
    const disable = w.audit().find(a => a.action === 'mta_sts.disable')!;
    expect(JSON.parse(disable.after_value).kept).toHaveLength(1);
  });
});
