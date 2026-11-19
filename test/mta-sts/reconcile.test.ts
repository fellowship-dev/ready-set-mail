// R2 item 2: the policy host is reconciled and the policy is PROVED by fetching it. One function (src/mta-sts/reconcile.ts) is used by the daily job and by
// "Check now" (verify): for every enabled row it makes sure the custom hostname exists and is not moved, that the ONE declared route is in the zone, and then
// fetches https://mta-sts.<domain>/.well-known/mta-sts.txt (status 200, text/plain, the exact policy, over a valid certificate). The page's "served" is that
// fetch and nothing else, and the `_mta-sts` id is not published (or advanced) while the fetch fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { INTAKE, OP, OP_ZONE, mtaWorld, quietLogs, type MtaWorld } from './world';
import { POLICY_ROUTE_PATTERN } from '../../src/mta-sts/policy-host';
import { refreshMtaStsHosted } from '../../src/mta-sts/refresh';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const POLICY = 'version: STSv1\nmode: testing\nmx: mx.a-corp.com\nmax_age: 86400\n';
const HOST = 'mta-sts.a-corp.com';

/** Domain 1 enabled via Cloudflare, certificate active, policy served and its id published. */
async function active(w: MtaWorld) {
  await w.mta(w.A.token, 'POST', 1);
  w.cf.cname[HOST] = OP.target;
  w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
  w.cf.activateHostname(HOST);
  await w.mta(w.A.token, 'POST', 1, undefined, '/verify');
  expect(w.row(1).state).toBe('active');
}
const idRecord = (w: MtaWorld) => w.cf.records.get(w.Z.a1)?.find((r) => r.name === '_mta-sts.a-corp.com');
const operatorWrites = (w: MtaWorld) => w.writes(OP_ZONE).map((c) => `${c.method} ${new URL(c.url).pathname.replace(/^\/client\/v4\/zones\/[^/]+/, '')}`);
const served = async (w: MtaWorld) => (await w.json(await w.mta(w.A.token, 'GET', 1))).served;
const verify = async (w: MtaWorld) => w.json(await w.mta(w.A.token, 'POST', 1, undefined, '/verify'));

describe('the custom hostname', () => {
  it('deleted at Cloudflare: reconcile creates exactly one (looks up first, never a second) and says the policy cannot be reached until its certificate is active', async () => {
    const w = await mtaWorld();
    await active(w);
    const before = w.row(1).ch_id;
    w.cf.customHostnames[OP_ZONE] = [];
    w.cf.calls.length = 0;
    const out = await verify(w);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(operatorWrites(w).filter((c) => c.includes('custom_hostnames'))).toEqual(['POST /custom_hostnames']);
    expect(w.row(1).ch_id).not.toBe(before);
    expect(w.row(1)).toMatchObject({ ch_status: 'pending', fetch_ok: 0, fetch_reason: 'certificate' });
    expect(out.checks.find((c: any) => c.key === 'policy_fetch')).toMatchObject({ state: 'error' });
    expect(await served(w)).toMatchObject({ ok: false, reason: 'certificate' });
    // a second run finds it and writes nothing more
    w.cf.calls.length = 0;
    await verify(w);
    expect(operatorWrites(w)).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
  });

  it('found by name when its id was never stored (a crash between the two writes)', async () => {
    const w = await mtaWorld();
    await active(w);
    const id = w.row(1).ch_id;
    w.db.sqlite.prepare('UPDATE mta_sts_config SET ch_id = NULL WHERE domain_id = 1').run();
    w.cf.calls.length = 0;
    await verify(w);
    expect(operatorWrites(w)).toEqual([]);
    expect(w.row(1).ch_id).toBe(id);
  });

  it('"moved" (it gave up validating, or the CNAME no longer points at the fallback origin) is refreshed with a PATCH, not re-created', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.customHostnames[OP_ZONE][0].status = 'moved';
    w.cf.calls.length = 0;
    await verify(w);
    expect(operatorWrites(w)).toEqual([`PATCH /custom_hostnames/${w.row(1).ch_id}`]);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(w.row(1)).toMatchObject({ ch_status: 'pending' });
  });
});

describe('where the fetch goes', () => {
  it('the policy address, unless a local run points POLICY_FETCH_BASE_URL at a localhost origin (anything else is ignored)', async () => {
    const { policyFetchUrl } = await import('../../src/mta-sts/reconcile');
    expect(policyFetchUrl('a-corp.com', {})).toBe('https://mta-sts.a-corp.com/.well-known/mta-sts.txt');
    expect(policyFetchUrl('a-corp.com', { POLICY_FETCH_BASE_URL: 'http://127.0.0.1:8861' })).toBe('http://127.0.0.1:8861/policy-fetch/mta-sts.a-corp.com/.well-known/mta-sts.txt');
    for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example', 'http://localhost:80@evil.example', '']) expect(policyFetchUrl('a-corp.com', { POLICY_FETCH_BASE_URL: bad }), bad).toBe('https://mta-sts.a-corp.com/.well-known/mta-sts.txt');
  });
});

describe('a CAA record on the customer\'s domain', () => {
  it('when Cloudflare reports it as the reason the certificate is not issued, the row says so in one sentence, and stops saying it once it is gone', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    w.cf.customHostnames[OP_ZONE][0].ssl = { status: 'pending_validation', validation_errors: [{ message: 'caa_error: CAA records do not allow the certificate authority' }] } as any;
    await verify(w);
    expect(w.row(1).last_error).toBe('A CAA record on your domain does not allow the certificate authorities Cloudflare uses (pki.goog, letsencrypt.org, ssl.com, sectigo.com): add them or remove that record.');
    w.cf.customHostnames[OP_ZONE][0].ssl = { status: 'pending_validation', validation_errors: [] } as any;
    await verify(w);
    expect(w.row(1).last_error).toBeNull();
  });
});

describe('the declared route', () => {
  it('present: nothing is written, and the id of the declared route is kept', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.calls.length = 0;
    await verify(w);
    expect(operatorWrites(w)).toEqual([]);
    expect(w.row(1).route_id).toBe('route-declared');
  });

  it('missing (a deploy without it): re-created, exactly that one pattern, and said loudly', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.routes[OP_ZONE] = [];
    const loud = vi.spyOn(console, 'error');
    w.cf.calls.length = 0;
    await verify(w);
    expect(operatorWrites(w)).toEqual(['POST /workers/routes']);
    expect(w.cf.routes[OP_ZONE]).toEqual([expect.objectContaining({ pattern: POLICY_ROUTE_PATTERN, script: 'rsm-worker' })]);
    expect(loud).toHaveBeenCalledWith(expect.stringContaining('declared route'));
  });

  it('enable never makes a route of its own for the domain: the zone has the one declared route', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    expect(operatorWrites(w)).toEqual(['POST /custom_hostnames']);
    expect(w.cf.routes[OP_ZONE].map((r) => r.pattern)).toEqual([POLICY_ROUTE_PATTERN]);
  });

  it('a wider route to this Worker (it would let the dashboard answer on a customer name) is said loudly and never touched; the declared one is not wide', async () => {
    const w = await mtaWorld();
    await active(w);
    const loud = vi.spyOn(console, 'error');
    await verify(w);
    expect(loud).not.toHaveBeenCalledWith(expect.stringContaining('reaches policy hosts'));
    w.cf.routes[OP_ZONE].push({ id: 'route-wide', pattern: '*/*', script: 'rsm-worker' }, { id: 'route-other', pattern: 'other.example.com/*', script: 'rsm-worker' });
    w.cf.calls.length = 0;
    const r = await verify(w);
    expect(loud).toHaveBeenCalledWith(expect.stringContaining('route */* in'));
    expect(loud).not.toHaveBeenCalledWith(expect.stringContaining('other.example.com'));
    expect(operatorWrites(w)).toEqual([]);
    expect(w.cf.routes[OP_ZONE].map((x) => x.id)).toContain('route-wide');
  });

  it('a per-domain route left by an earlier build is taken away once the declared one is there (a dashboard-defined route does not survive a deploy)', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.routes[OP_ZONE].push({ id: 'route-old', pattern: 'mta-sts.a-corp.com/*', script: 'rsm-worker' });
    w.db.sqlite.prepare("UPDATE mta_sts_config SET route_id = 'route-old' WHERE domain_id = 1").run();
    await verify(w);
    expect(w.cf.routes[OP_ZONE].map((r) => r.id)).toEqual(['route-declared']);
    expect(w.row(1).route_id).toBe('route-declared');
  });
});

describe('the fetch is the proof (status 200, text/plain, the exact policy, a valid certificate)', () => {
  const cases: Array<[string, string, (w: MtaWorld) => void]> = [
    ['404', 'not_found', (w) => { w.cf.policyServer = () => new Response('Not found', { status: 404 }); }],
    ['a wrong body (another MX list)', 'wrong_body', (w) => { w.cf.policyServer = () => new Response(POLICY.replace('mx.a-corp.com', 'mx.elsewhere.example'), { headers: { 'Content-Type': 'text/plain' } }); }],
    ['a wrong content type', 'wrong_content_type', (w) => { w.cf.policyServer = () => new Response(POLICY, { headers: { 'Content-Type': 'text/html' } }); }],
    ['a redirect', 'redirect', (w) => { w.cf.policyServer = () => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example/' } }); }],
    ['a server error', 'unexpected_status', (w) => { w.cf.policyServer = () => new Response('boom', { status: 503 }); }],
    ['a TLS error', 'certificate', (w) => { w.cf.policyServer = () => { throw new TypeError('fetch failed: certificate has expired'); }; }],
    ['a network error', 'unreachable', (w) => { w.cf.policyServer = () => { throw new TypeError('fetch failed: connection refused'); }; }],
  ];

  it.each(cases)('%s: not served, with the reason; nothing is rewritten', async (_name, reason, arrange) => {
    const w = await mtaWorld();
    await active(w);
    arrange(w);
    w.cf.calls.length = 0;
    const out = await verify(w);
    expect(w.row(1)).toMatchObject({ fetch_ok: 0, fetch_reason: reason, state: 'active' });
    expect(out.checks.find((c: any) => c.key === 'policy_fetch')).toMatchObject({ state: expect.stringMatching(/wrong|error/) });
    const s = await served(w);
    expect(s).toMatchObject({ ok: false, reason, url: `https://${HOST}/.well-known/mta-sts.txt` });
    expect(s.message).toMatch(/Check now|record/i);
    expect(w.writes(w.Z.a1)).toEqual([]);
  });

  it('a passing fetch is "served", and a policy file with a trailing difference is not', async () => {
    const w = await mtaWorld();
    await active(w);
    expect(await served(w)).toMatchObject({ ok: true, reason: null, checked_at: expect.any(Number) });
    w.cf.policyServer = () => new Response(POLICY + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    await verify(w);
    expect(await served(w)).toMatchObject({ ok: false, reason: 'wrong_body' });
    w.cf.policyServer = () => new Response(POLICY, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    await verify(w);
    expect(await served(w)).toMatchObject({ ok: true });
  });

  it('does not follow redirects, sends no cache, and gives up after a few seconds', async () => {
    const w = await mtaWorld();
    await active(w);
    const seen: RequestInit[] = [];
    w.cf.policyServer = (url, init) => { seen.push(init ?? {}); return new Response(POLICY, { headers: { 'Content-Type': 'text/plain' } }); };
    await verify(w);
    expect(seen[0]).toMatchObject({ redirect: 'manual' });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(seen[0].headers).get('cache-control')).toBe('no-cache');
  });

  it('a rerun with nothing changed writes nothing anywhere and changes nothing but the check times', async () => {
    const w = await mtaWorld();
    await active(w);
    const strip = (r: any) => ({ ...r, updated_at: 0, last_checked_at: 0, fetch_checked_at: 0 });
    const before = strip(w.row(1));
    w.cf.calls.length = 0;
    await verify(w);
    await verify(w);
    expect(w.cf.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(strip(w.row(1))).toEqual(before);
  });
});

describe('the id is not published while the policy cannot be fetched', () => {
  it('enable: the certificate is active but the fetch fails: state waiting_policy, no _mta-sts record; it publishes once the fetch passes', async () => {
    const w = await mtaWorld();
    const pass = w.cf.policyServer!;
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    await w.mta(w.A.token, 'POST', 1);
    w.cf.cname[HOST] = OP.target;
    w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
    w.cf.activateHostname(HOST);
    const out = await verify(w);
    expect(out.state).toBe('waiting_policy');
    expect(idRecord(w)).toBeUndefined();
    expect(w.row(1)).toMatchObject({ state: 'waiting_policy', policy_published_at: null, fetch_ok: 0, fetch_reason: 'not_found' });
    w.cf.policyServer = pass;
    expect((await verify(w)).state).toBe('active');
    expect(idRecord(w)!.content).toMatch(/^v=STSv1; id=\d{14}a?$/);
    expect(w.row(1).policy_published_at).toBeGreaterThan(0);
  });

  it('enable when the hostname is already active (the operator\'s own domain) but the fetch fails: not published, not active', async () => {
    const w = await mtaWorld();
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    await w.mta(w.A.token, 'POST', 1);
    w.cf.activateHostname(HOST);
    w.cf.cname[HOST] = OP.target;
    await verify(w);
    expect(idRecord(w)).toBeUndefined();
  });

  it('a mode change: the new policy is stored, the fetch fails, so the stored change is undone and the id stays', async () => {
    const w = await mtaWorld();
    await active(w);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET mode_changed_at = ?, policy_published_at = ? WHERE domain_id = 1').run(now() - 10 * DAY, now() - 10 * DAY);
    w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id, reporter_tier, reporter_identity) VALUES (1, 'Google', ?, ?, 40, 0, 40, 0, '[]', ?, 'counted', 'google')").run(now() - 3 * DAY, now() - 2 * DAY, w.A.ws);
    const id = idRecord(w)!.content;
    const policyId = w.row(1).policy_id;
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    const res = await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    expect(res.status).toBe(502);
    expect((await w.json(res)).error).toMatch(/cannot be reached/);
    expect(w.row(1)).toMatchObject({ mode: 'testing', policy_id: policyId });
    expect(idRecord(w)!.content).toBe(id);
  });

  it('an MX change in the daily job: same rule, the id is not advanced and the row says why', async () => {
    const w = await mtaWorld();
    await active(w);
    const id = idRecord(w)!.content;
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.', '20 mx2.a-corp.com.'];
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    await refreshMtaStsHosted(w.env as any);
    expect(idRecord(w)!.content).toBe(id);
    expect(w.row(1).mx_hosts).toBe('mx.a-corp.com');
    expect(w.row(1).last_error).toMatch(/cannot be reached/);
  });
});

describe('who runs it, and when', () => {
  it('the daily job reconciles first: a deleted hostname is back after one run', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.customHostnames[OP_ZONE] = [];
    await refreshMtaStsHosted(w.env as any);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(w.row(1)).toMatchObject({ fetch_ok: 0 });
  });

  it('after a deploy the operator triggers it once with POST /api/instance/mta-sts/reconcile (instance owner only) and reads the result', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.routes[OP_ZONE] = [];
    expect((await w.api(w.member, 'POST', '/api/instance/mta-sts/reconcile')).status).toBe(403);
    expect(w.cf.routes[OP_ZONE]).toEqual([]);
    const res = await w.api(w.A.token, 'POST', '/api/instance/mta-sts/reconcile');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, visited: 1, served: 1, not_served: 0 });
    expect(w.cf.routes[OP_ZONE]).toHaveLength(1);
    expect((await w.api(w.A.token, 'GET', '/api/instance/mta-sts/reconcile')).status).toBe(405);
  });
});

describe('opening the page fetches the policy again when the last check is old (round 4)', () => {
  const view = async (w: MtaWorld) => w.json(await w.mta(w.A.token, 'GET', 1));
  const age = (w: MtaWorld, seconds: number) => w.db.sqlite.prepare('UPDATE mta_sts_config SET fetch_checked_at = ? WHERE domain_id = 1').run(now() - seconds);
  const count = (w: MtaWorld) => { const n = { fetches: 0 }; const was = w.cf.policyServer; w.cf.policyServer = (u, i) => { n.fetches++; return was!(u, i); }; return n; };
  const enforceServed = (b: any) => b.enforce.checks.find((k: any) => k.key === 'served');

  it('the policy starts answering 404: the next view says it cannot be reached and the enforce item is missing', async () => {
    const w = await mtaWorld();
    await active(w);
    age(w, 3600);
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    const b = await view(w);
    expect(b.served).toMatchObject({ ok: false, reason: 'not_found', could_not_check: false });
    expect(b.served.checked_at).toBeGreaterThan(now() - 60);
    expect(w.row(1)).toMatchObject({ fetch_ok: 0, fetch_reason: 'not_found' });
    expect(enforceServed(b)).toMatchObject({ met: false, reasons: ['The policy cannot be reached right now.'] });
  });

  it('a fetch that times out: "could not check", the last known result and its time, nothing stored', async () => {
    const w = await mtaWorld();
    await active(w);
    age(w, 3600);
    const before = w.row(1);
    w.cf.policyServer = () => { throw new DOMException('The operation timed out', 'TimeoutError'); };
    const b = await view(w);
    expect(b.served).toMatchObject({ ok: true, could_not_check: true, checked_at: before.fetch_checked_at });
    expect(w.row(1)).toMatchObject({ fetch_ok: 1, fetch_reason: null, fetch_checked_at: before.fetch_checked_at });
    expect(enforceServed(b)).toMatchObject({ met: false, reasons: ['The policy could not be checked just now.'] });
  });

  it('a result under ten minutes old is not fetched again; one over ten minutes is, once per view', async () => {
    const w = await mtaWorld();
    await active(w);
    const n = count(w);
    age(w, 540);
    expect((await view(w)).served).toMatchObject({ ok: true, could_not_check: false });
    expect(n.fetches).toBe(0);
    age(w, 660);
    await view(w);
    expect(n.fetches).toBe(1);
    await view(w);
    expect(n.fetches).toBe(1);
  });

  it('Check now fetches again however recent the last check', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    const n = count(w);
    expect(await verify(w)).toMatchObject({ served: { ok: false, reason: 'not_found' } });
    expect(n.fetches).toBe(1);
  });
});
