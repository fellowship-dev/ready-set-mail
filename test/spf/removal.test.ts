// A flattened record must never be left frozen in Cloudflare with the original lost: deleting the domain, the workspace or the connection puts the original
// back first, and where that cannot be done the delete stops (domain, workspace) or flattening stops with the original kept (connection, revocation, lost proof).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { world, Z, type World } from '../connections/world';
import { loadTenant } from '../../src/tenancy/load';
import { withdrawProof } from '../../src/domains/proof-recheck';
import { refreshSpf, spfView } from '../../src/spf/refresh';
import { CfConnectionError } from '../../src/tenancy/cf-client';
import { claimLookups } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { for (const m of ['warn', 'log', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const SPF_ID = 'c0'.repeat(16);
const ORIGINAL = 'v=spf1 include:mail.test include:other.test -all';
const FLAT = 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all';

/** Workspace A with a domain, a token connection linked to it, an SPF record in its zone, and flattening on. */
async function flattened() {
  const w = await world({ HOSTED_SPF_FLATTENING: 'all' });
  const conn = await w.addToken(w.A.token, 'secret-token-aaaaaaaaaaaa-1');
  expect((await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${conn.id}/zones`, { zone_ids: [Z.a1] })).status).toBe(200);
  expect((await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: conn.id })).status).toBe(200);
  w.cf.seed(Z.a1, { id: SPF_ID, type: 'TXT', name: 'a-corp.com', content: ORIGINAL });
  w.cf.realisticTxt = true;
  w.cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.0/28 ~all'];
  w.cf.doh['other.test'] = ['v=spf1 ip4:203.0.113.9 -all'];
  const on = await w.api(w.A.token, 'POST', '/api/domains/1/spf-flatten', { anyway: true });
  expect(on.status, await on.clone().text()).toBe(201);
  const live = () => w.cf.records.get(Z.a1)!.find(r => r.id === SPF_ID)!.content.replace(/^"|"$/g, '');
  expect(live()).toBe(FLAT);
  const row = () => w.rows('SELECT enabled, flattened_record, problem_kind, last_error FROM spf_flatten_config WHERE domain_id = 1')[0] as { enabled: number; flattened_record: string; problem_kind: string | null; last_error: string | null } | undefined;
  const audits = (action: string) => w.rows('SELECT action, meta FROM audit_log WHERE action = ?', action);
  return { w, conn, live, row, audits };
}
type F = Awaited<ReturnType<typeof flattened>>;
/** Cloudflare answers every call about this zone with a 500 from now on. */
/** Cloudflare accepts reads but refuses every change to a DNS record (the token lost its edit permission, say). */
const breakWrites = (f: F) => {
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.includes('/dns_records/')) return new Response(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }), { status: 403 });
    return inner(input, init);
  });
  void f;
};
const breakZone = (f: F) => { f.w.cf.failZone = { zoneId: Z.a1, status: 500, message: 'Internal error' }; };

describe('deleting a domain', () => {
  it('puts the original record back first, then deletes', async () => {
    const f = await flattened();
    const res = await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1');
    expect(res.status).toBe(200);
    expect(f.live()).toBe(ORIGINAL);
    expect(f.row()).toBeUndefined();
    expect(f.w.rows('SELECT id FROM domains WHERE id = 1')).toEqual([]);
    expect(f.audits('spf_flatten.disable')).toHaveLength(1);
  });

  it('stops when the original cannot be put back: 409 with the reason and the original to copy; nothing is deleted', async () => {
    const f = await flattened();
    breakZone(f);
    const res = await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1');
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({ code: 'spf_restore_failed', domain: 'a-corp.com', original: ORIGINAL, flattened_record: FLAT, leave_param: 'leave_spf_record=1' });
    expect(body.error).toContain('We could not put your original record back in Cloudflare.');
    expect(body.error).toContain(ORIGINAL);
    expect(f.w.rows('SELECT id FROM domains WHERE id = 1')).toHaveLength(1);
    expect(f.row()).toMatchObject({ enabled: 0, problem_kind: 'restore_failed', flattened_record: FLAT }); // stopped, the original still stored
  });

  it('the same when Cloudflare reads but refuses the write', async () => {
    const f = await flattened();
    breakWrites(f);
    const res = await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1');
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('We could not put your original record back in Cloudflare.');
    expect(f.live()).toBe(FLAT);
  });

  it('leave_spf_record=1 deletes anyway, and the audit log keeps what stayed in DNS and the original', async () => {
    const f = await flattened();
    breakZone(f);
    expect((await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1')).status).toBe(409);
    const res = await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1?leave_spf_record=1');
    expect(res.status).toBe(200);
    expect(f.w.rows('SELECT id FROM domains WHERE id = 1')).toEqual([]);
    const [entry] = f.w.rows("SELECT before_value, after_value FROM audit_log WHERE action = 'spf_flatten.left_in_dns'");
    expect(JSON.parse(entry.before_value)).toEqual({ spf_record: FLAT });
    expect(JSON.parse(entry.after_value)).toEqual({ original_record: ORIGINAL });
  });

  it('a record someone edited in Cloudflare is not written over, and does not stop the delete', async () => {
    const f = await flattened();
    f.w.cf.records.get(Z.a1)!.find(r => r.id === SPF_ID)!.content = '"v=spf1 include:mine.example -all"';
    expect((await f.w.api(f.w.A.token, 'DELETE', '/api/domains/1')).status).toBe(200);
    expect(f.live()).toBe('v=spf1 include:mine.example -all');
  });

  it('a domain without flattening is deleted as before', async () => {
    const w = await world({ HOSTED_SPF_FLATTENING: 'all' });
    expect((await w.api(w.A.token, 'DELETE', '/api/domains/2')).status).toBe(200);
  });
});

describe('deleting a workspace', () => {
  async function twoWorkspaces(f: F) {
    const made = await f.w.api(f.w.A.token, 'POST', '/api/workspaces', { name: 'Second' });
    expect(made.status).toBe(201);
    const A = f.w.A.ws;
    const name = f.w.rows('SELECT name FROM workspaces WHERE id = ?', A)[0].name as string;
    return { A, name, url: (extra = '') => `/api/workspaces/${A}?confirm=${encodeURIComponent(name)}${extra}` };
  }

  it('restores every flattened record before anything is deleted', async () => {
    const f = await flattened();
    const { A, url } = await twoWorkspaces(f);
    const res = await f.w.api(f.w.A.token, 'DELETE', url());
    expect(res.status, await res.clone().text()).toBe(200);
    expect(f.live()).toBe(ORIGINAL);
    expect(f.w.rows('SELECT id FROM workspaces WHERE id = ?', A)).toEqual([]);
  });

  it('stops with nothing deleted when an original cannot be put back: 409, the originals in the answer; leave_spf_record=1 deletes anyway', async () => {
    const f = await flattened();
    const { A, url } = await twoWorkspaces(f);
    breakWrites(f);
    const res = await f.w.api(f.w.A.token, 'DELETE', url());
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'spf_restore_failed', domains: [{ domain: 'a-corp.com', original: ORIGINAL, flattened_record: FLAT }], leave_param: 'leave_spf_record=1' });
    expect(f.w.rows('SELECT id FROM workspaces WHERE id = ?', A)).toHaveLength(1);
    expect(f.w.rows('SELECT id FROM domains WHERE workspace_id = ?', A).map((d: any) => d.id)).toEqual([1, 2]);
    expect(f.live()).toBe(FLAT);
    const forced = await f.w.api(f.w.A.token, 'DELETE', url('&leave_spf_record=1'));
    expect(forced.status, await forced.clone().text()).toBe(200);
    expect(f.w.rows('SELECT id FROM workspaces WHERE id = ?', A)).toEqual([]);
  });

  it('eraseWorkspace itself: an original that cannot be put back stops it before the first delete, with every original in the answer', async () => {
    const f = await flattened();
    const { eraseWorkspace } = await import('../../src/workspaces/routes');
    const { deleteDomain } = await import('../../src/api/router');
    const tenant = await loadTenant(f.w.env, { workspaceId: f.w.A.ws });
    breakZone(f);
    const deps = { db: f.w.env.DB, mode: 'saas' as const, env: f.w.env, tenantFor: (id: string) => loadTenant(f.w.env, { workspaceId: id }), preflight: async () => null, deleteDomain };
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const domains = [{ id: 1, domain: 'a-corp.com' }, { id: 2, domain: 'a-two.org' }];
    const r = await eraseWorkspace(deps, ctx, tenant, domains, { id: 'u' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(409);
    const body = await json(r.response);
    expect(body).toMatchObject({ code: 'spf_restore_failed', domains: [{ domain: 'a-corp.com', original: ORIGINAL, flattened_record: FLAT }] });
    expect(body.error).toMatch(/^The SPF record of a-corp.com could not be put back to its original, so nothing was deleted\./);
    expect(f.w.rows('SELECT id FROM domains ORDER BY id').map((d: any) => d.id)).toEqual([1, 2, 3]);
  });
});

describe('removing the Cloudflare connection', () => {
  it('puts the original back while the connection still works, and says so', async () => {
    const f = await flattened();
    const res = await f.w.api(f.w.A.token, 'DELETE', `/api/cloudflare/connections/${f.conn.id}`);
    expect(await json(res)).toMatchObject({ ok: true, spf_flattened: [{ domain: 'a-corp.com', restored: true, original: ORIGINAL }] });
    expect(f.live()).toBe(ORIGINAL);
    expect(f.row()).toBeUndefined();
  });

  it('where the original cannot be put back, flattening stops, the row keeps the original, and the answer says so', async () => {
    const f = await flattened();
    breakZone(f);
    const res = await f.w.api(f.w.A.token, 'DELETE', `/api/cloudflare/connections/${f.conn.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.spf_flattened).toEqual([expect.objectContaining({ domain: 'a-corp.com', restored: false, original: ORIGINAL, flattened_record: FLAT })]);
    expect(body.spf_flattened[0].message).toContain(`set the SPF TXT record of a-corp.com to: ${ORIGINAL}`);
    expect(f.row()).toMatchObject({ enabled: 0, problem_kind: 'connection_gone', flattened_record: FLAT });
    expect(f.w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
    // the daily job does not pick it up again
    f.w.cf.calls.length = 0;
    const { runSpfRefresh, newSpfBudget } = await import('../../src/spf/refresh');
    await runSpfRefresh(await loadTenant(f.w.env, { workspaceId: f.w.A.ws }), undefined, newSpfBudget());
    expect(f.w.cf.calls).toEqual([]);
  });
});

describe('a connection that was revoked', () => {
  it('the refresh stops flattening instead of trying every day; the view names the record in DNS and the original', async () => {
    const f = await flattened();
    const tenant = await loadTenant(f.w.env, { workspaceId: f.w.A.ws });
    const row = (await tenant.scope.spf.get(1))!;
    const target = { read: async () => { throw new CfConnectionError('revoked', 'The connection was disconnected'); }, write: async () => { throw new Error('no write'); } };
    const r = await refreshSpf(tenant, row, { target: target as never });
    expect(r.outcome).toBe('problem');
    const after = (await tenant.scope.spf.get(1))!;
    expect(after.enabled).toBe(0);
    const view = spfView(after);
    expect(view).toMatchObject({ enabled: false, original_record: ORIGINAL, flattened_record: FLAT, problem: { kind: 'connection_gone' } });
    expect(view.problem!.message).toContain('Cloudflare connection for a-corp.com was disconnected');
    expect(view.problem!.message).toContain(`set the SPF TXT record of a-corp.com to: ${ORIGINAL}`);
    expect(f.audits('spf_flatten.stopped')).toHaveLength(1);
  });
});

describe('an ownership proof that is lost', () => {
  it('stops flattening: no refresh writes to a domain that is no longer proven', async () => {
    const f = await flattened();
    f.w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', cf_zone_id = ?, cf_zone_name = 'a-corp.com' WHERE id = 1").run(Z.a1);
    const holder = (await claimLookups(f.w.env.DB).zoneVerifiedNear('a-corp.com', 'nobody'))[0];
    expect(holder).toBeTruthy();
    expect(await withdrawProof(f.w.env, holder!, 'delegation')).toBe(true);
    expect(f.row()).toMatchObject({ enabled: 0, problem_kind: 'proof_lost', flattened_record: FLAT });
    expect(f.row()!.last_error).toContain('We can no longer show that you control a-corp.com');
    expect(f.row()!.last_error).toContain(`set the SPF TXT record of a-corp.com to: ${ORIGINAL}`);
    expect(f.live()).toBe(FLAT); // nothing was written
    expect(f.audits('spf_flatten.stopped')).toHaveLength(1);
  });
});
