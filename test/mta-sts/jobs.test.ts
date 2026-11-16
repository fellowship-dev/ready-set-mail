// The daily job (both modes share one function), the operator-side reconcile, and the removal paths that must tear MTA-STS down.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { runCronForWorkspaces } from '../../src/cron';
import { runHostedCron } from '../../src/hosted/cron';
import { reconcileOperatorZone, refreshMtaStsHosted } from '../../src/mta-sts/refresh';
import { withdrawProof } from '../../src/domains/proof-recheck';
import { removeMtaSts } from '../../src/domains/remove';
import { loadTenant } from '../../src/tenancy/load';
import { INTAKE, OP, OP_ZONE, mtaWorld, quietLogs, type MtaWorld, onlyDeclaredRoute } from './world';
import { POLICY_ROUTE_PATTERN } from '../../src/mta-sts/policy-host';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
async function active(w: MtaWorld, id = 1, domain = 'a-corp.com') {
  await w.mta(w.A.token, 'POST', id);
  w.cf.cname[`mta-sts.${domain}`] = OP.target;
  w.cf.doh[`_smtp._tls.${domain}`] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
  w.cf.activateHostname(`mta-sts.${domain}`);
  await w.mta(w.A.token, 'POST', id, undefined, '/verify');
}
const customerWrites = (w: MtaWorld) => w.writes(w.Z.a1);

describe('refreshMtaStsHosted', () => {
  it('rerun with no DNS change changes nothing but the time it looked', async () => {
    const w = await mtaWorld();
    await active(w);
    const before = w.row(1);
    const calls = w.cf.calls.length;
    const stats = await refreshMtaStsHosted(w.env);
    expect(stats).toMatchObject({ visited: 1, changed: 0, errors: 0 });
    const after = w.row(1);
    expect({ ...after, last_checked_at: 0, updated_at: 0 }).toEqual({ ...before, last_checked_at: 0, updated_at: 0 });
    expect(after.last_checked_at).toBeGreaterThan(0);
    expect(w.cf.calls.slice(calls).filter((c) => c.method !== 'GET')).toEqual([]);
    await refreshMtaStsHosted(w.env);
    expect(w.row(1).policy_id).toBe(before.policy_id);
  });

  it('a changed MX list: new id, the record updated, the person told', async () => {
    const w = await mtaWorld();
    await active(w);
    const old = w.row(1).policy_id;
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.', '20 mx9.a-corp.com.'];
    expect(await refreshMtaStsHosted(w.env)).toMatchObject({ changed: 1 });
    const row = w.row(1);
    expect(row.mx_hosts).toBe('mx.a-corp.com,mx9.a-corp.com');
    expect(row.policy_id).not.toBe(old);
    expect(w.cf.records.get(w.Z.a1)!.find((r) => r.name === '_mta-sts.a-corp.com')!.content).toBe(`v=STSv1; id=${row.policy_id}`);
    expect(row.notice).toMatch(/Your MX hosts changed/);
    expect(w.rows("SELECT actor_type FROM audit_log WHERE action = 'mta_sts.mx_refresh'")).toEqual([{ actor_type: 'system' }]);
  });

  it('a DNS error keeps everything; an empty MX never publishes and leaves a notice (once)', async () => {
    const w = await mtaWorld();
    await active(w);
    const before = w.row(1);
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (String(input).includes('type=MX') ? new Response('x', { status: 500 }) : inner(input, init)));
    await refreshMtaStsHosted(w.env);
    expect(w.row(1)).toMatchObject({ mx_hosts: before.mx_hosts, policy_id: before.policy_id });
    expect(w.row(1).last_error).toMatch(/MX lookup failed/);
    vi.stubGlobal('fetch', inner);
    delete w.cf.mx['a-corp.com'];
    await refreshMtaStsHosted(w.env);
    expect(w.row(1)).toMatchObject({ mx_hosts: before.mx_hosts, policy_id: before.policy_id });
    expect(w.row(1).notice).toMatch(/No MX records were found/);
    const at = w.row(1).notice_at;
    await refreshMtaStsHosted(w.env);
    expect(w.row(1).notice_at).toBe(at);
    expect(customerWrites(w).filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('moves setup forward: a certificate that became active publishes the _mta-sts TXT', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    w.cf.cname['mta-sts.a-corp.com'] = OP.target;
    w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
    await refreshMtaStsHosted(w.env);
    expect(w.row(1).state).toBe('waiting_certificate');
    w.cf.activateHostname('mta-sts.a-corp.com');
    await refreshMtaStsHosted(w.env);
    expect(w.row(1).state).toBe('active');
    expect(w.cf.records.get(w.Z.a1)!.some((r) => r.name === '_mta-sts.a-corp.com')).toBe(true);
  });

  it('visits the oldest-checked first and at most `limit` per run', async () => {
    const w = await mtaWorld();
    await active(w);
    await w.mta(w.A.token, 'POST', 2);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET last_checked_at = ? WHERE domain_id = 1').run(now() - 100);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET last_checked_at = ? WHERE domain_id = 2').run(now() - 5000);
    expect(await refreshMtaStsHosted(w.env, undefined, 1)).toMatchObject({ visited: 1 });
    expect(w.row(2).last_checked_at).toBeGreaterThan(now() - 100);
    expect(w.row(1).last_checked_at).toBe(now() - 100);
    // never-checked rows come first of all
    w.db.sqlite.prepare('UPDATE mta_sts_config SET last_checked_at = NULL WHERE domain_id = 1').run();
    await refreshMtaStsHosted(w.env, undefined, 1);
    expect(w.row(1).last_checked_at).toBeGreaterThan(0);
  });

  it('a domain whose row is gone, or a workspace that fails, does not stop the others', async () => {
    const w = await mtaWorld();
    await active(w);
    await w.mta(w.A.token, 'POST', 2);
    w.db.sqlite.prepare("UPDATE mta_sts_config SET mx_hosts = 'old.a-two.org' WHERE domain_id = 2").run();
    w.cf.activateHostname('mta-sts.a-two.org'); // its policy is served, so the new id may go out
    w.cf.failZone = { zoneId: w.Z.a1, status: 500, message: 'down' };
    const stats = await refreshMtaStsHosted(w.env);
    expect(stats.visited).toBe(2);
    expect(w.row(2).mx_hosts).toBe('mx.a-two.org');
  });
});

describe('the cron wiring (one function, the cron that is on for each mode)', () => {
  it('saas: the 11:00 hosted job refreshes; the per-workspace 08:00 branch does not run MTA-STS (so it never runs twice)', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.', '20 mx5.a-corp.com.'];
    await runCronForWorkspaces({ cron: '0 8 * * *' } as ScheduledController, w.env, ctx, { workspaces: [w.A.ws], load: (env, ws) => loadTenant(env, ws) });
    expect(w.row(1).mx_hosts).toBe('mx.a-corp.com');
    await runHostedCron({ cron: '0 11 * * *' } as ScheduledController, w.env, ctx);
    expect(w.row(1).mx_hosts).toBe('mx.a-corp.com,mx5.a-corp.com');
  });
});

describe('reconcileOperatorZone', () => {
  it('removes the custom hostnames mta-sts.<d> and the per-domain routes of an earlier build that no row owns; leaves the declared route and everything else', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.routes[OP_ZONE].push(
      { id: 'r-left', pattern: 'mta-sts.gone.example/*', script: 'rsm-worker' },
      { id: 'r-other', pattern: 'mta-sts.other.example/*', script: 'someone-elses-worker' },
      { id: 'r-site', pattern: 'www.readysetmail.com/*', script: 'rsm-worker' },
    );
    w.cf.customHostnames[OP_ZONE].push(
      { id: 'ch-left', hostname: 'mta-sts.gone.example', status: 'active', ssl: { status: 'active' } },
      { id: 'ch-theirs', hostname: 'mta-sts.other.example', status: 'active', ssl: { status: 'active' } },
      { id: 'ch-shop', hostname: 'shop.customer.example', status: 'active', ssl: { status: 'active' } },
    );
    // two hostnames and one route: the hostname of a name with no row is a leftover whoever's route it had (the zone is dedicated to policy hosts)
    expect(await reconcileOperatorZone(w.env)).toBe(3);
    expect(w.cf.routes[OP_ZONE].map((r) => r.id!).sort()).toEqual(['r-other', 'r-site', 'route-declared']);
    expect(w.cf.customHostnames[OP_ZONE].map((h) => h.hostname).sort()).toEqual(['mta-sts.a-corp.com', 'shop.customer.example']);
    expect(await reconcileOperatorZone(w.env)).toBe(0);
  });

  it('is bounded per run', async () => {
    const w = await mtaWorld();
    for (let i = 0; i < 5; i++) w.cf.routes[OP_ZONE] = [...(w.cf.routes[OP_ZONE] ?? []), { id: `r${i}`, pattern: `mta-sts.gone${i}.example/*`, script: 'rsm-worker' }];
    expect(await reconcileOperatorZone(w.env, 2)).toBe(2);
    expect(w.cf.routes[OP_ZONE]).toHaveLength(4); // the declared route and three left
  });

  it('does nothing on self-host or when policy hosting is not configured', async () => {
    const w = await mtaWorld({ POLICY_HOST_TOKEN: '' });
    expect(await reconcileOperatorZone(w.env)).toBe(0);
    expect(w.writes(OP_ZONE)).toEqual([]);
  });
});

describe('taking a domain out of service retires MTA-STS (test/mta-sts/retire.test.ts has the whole story)', () => {
  /** The retirement is over: its time is up and the daily job has run. */
  const finish = async (w: MtaWorld) => { w.db.sqlite.prepare('UPDATE mta_sts_retiring SET retire_after = ?').run(now() - 1); await refreshMtaStsHosted(w.env); };

  it('DELETE /api/domains/:id: the row goes with the domain, the policy keeps serving none; at the end the records, the hostname and the entry go, and a record the customer changed is kept and said so', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.records.get(w.Z.a1)!.find((r) => r.name === '_smtp._tls.a-corp.com')!.content = 'something the customer wrote';
    const res = await w.api(w.A.token, 'DELETE', '/api/domains/1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kept: [], mta_sts: { retiring: true, enforced: false } });
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    await finish(w);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(onlyDeclaredRoute(w)).toEqual([POLICY_ROUTE_PATTERN]);
    expect(w.cf.records.get(w.Z.a1)!.map((r) => r.name)).toEqual(['_smtp._tls.a-corp.com']);
    expect(w.rows('SELECT * FROM mta_sts_retiring')).toEqual([]);
    expect(w.rows("SELECT resource_name FROM audit_log WHERE action = 'dns.kept'").map((r) => r.resource_name)).toEqual(['_smtp._tls.a-corp.com']);
  });

  it('a lapsed proof (and its subdomains\' too) retires the policy; the policy host and the records go when it has expired', async () => {
    const w = await mtaWorld();
    await active(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', cf_name_servers = '[\"a.ns.cloudflare.com\"]', cf_zone_name = 'a-corp.com' WHERE id = 1").run();
    expect(await withdrawProof(w.env, { id: 1, workspace_id: w.A.ws, domain: 'a-corp.com', cf_zone_id: w.Z.a1, cf_zone_name: 'a-corp.com', cf_name_servers: '["a.ns.cloudflare.com"]', cf_account_id: 'cf-1', cf_connection_id: w.connection, proof_checked_at: null, proof_suspected_at: null }, 'cloudflare')).toBe(true);
    expect(w.rows('SELECT verified_via, proof_lost_at FROM domains WHERE id = 1')[0]).toMatchObject({ verified_via: 'legacy' });
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(w.rows('SELECT domain, reason FROM mta_sts_retiring')).toEqual([{ domain: 'a-corp.com', reason: 'lost_proof' }]);
    await finish(w);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(onlyDeclaredRoute(w)).toEqual([POLICY_ROUTE_PATTERN]);
    expect(w.cf.records.get(w.Z.a1)).toEqual([]);
  });

  it('an eviction (another workspace proves the name this workspace held unproven) retires the old holder\'s policy first; its records go at the end through the connection that wrote them', async () => {
    const w = await mtaWorld();
    await active(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run(); // proof gone, nobody noticed yet
    const added = await w.api(w.B.token, 'POST', '/api/domains', { domain: 'a-corp.com' });
    expect(added.status).toBe(202);
    const { claim } = await added.json() as any;
    w.cf.doh['_readysetmail.a-corp.com'] = [claim.txt_value];
    expect((await w.api(w.B.token, 'POST', `/api/domains/claims/${claim.id}/verify`, {})).status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'a-corp.com'")).toEqual([{ workspace_id: w.B.ws }]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(w.rows('SELECT domain, reason, workspace_id FROM mta_sts_retiring')).toEqual([{ domain: 'a-corp.com', reason: 'evicted', workspace_id: w.A.ws }]);
    await finish(w);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(onlyDeclaredRoute(w)).toEqual([POLICY_ROUTE_PATTERN]);
    // The new owner's insert detached the old holder's domain row, so nothing links its connection to the name any more: the retired policy remembers the connection
    // that wrote the records (by id, so only what we wrote is touched) and removes them through it.
    expect(w.cf.records.get(w.Z.a1)).toEqual([]);
    expect(w.rows("SELECT resource_name FROM audit_log WHERE workspace_id = ? AND action = 'dns.delete' ORDER BY resource_name", w.A.ws).map((r) => r.resource_name)).toEqual(['_mta-sts.a-corp.com', '_smtp._tls.a-corp.com', 'mta-sts.a-corp.com']);
  });

  it('removeMtaSts never throws: a Cloudflare outage still starts the retirement, and what is left at the end is kept for the daily job to try again', async () => {
    const w = await mtaWorld();
    await active(w);
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'DELETE' ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 }) : inner(input, init)));
    const tenant = await loadTenant(w.env, { workspaceId: w.A.ws });
    const domain = (await tenant.scope.domains.getById(1))!;
    expect((await removeMtaSts(tenant, domain)).retiring).toMatchObject({ retiring: true });
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(await removeMtaSts(tenant, domain)).toEqual({ kept: [], retiring: null }); // nothing to remove the second time
    await finish(w); // the hostname cannot be deleted now: the entry stays for tomorrow
    expect(w.rows('SELECT last_error FROM mta_sts_retiring')).toEqual([{ last_error: expect.stringMatching(/tried again tomorrow/) }]);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', inner);
    await refreshMtaStsHosted(w.env);
    expect(w.rows('SELECT * FROM mta_sts_retiring')).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
  });
});
