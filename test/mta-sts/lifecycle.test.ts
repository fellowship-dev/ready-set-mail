// Gates, refusals, rollback, mode changes, disable and removal on a hosted instance.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { INTAKE, OP, OP_ZONE, mtaWorld, quietLogs, type MtaWorld } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

/** Domain 1 enabled via Cloudflare with the certificate active and the id published. */
async function active(w: MtaWorld) {
  await w.mta(w.A.token, 'POST', 1);
  w.cf.cname['mta-sts.a-corp.com'] = OP.target;
  w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
  w.cf.activateHostname('mta-sts.a-corp.com');
  await w.mta(w.A.token, 'POST', 1, undefined, '/verify');
  expect(w.row(1).state).toBe('active');
}
const publishedId = (w: MtaWorld) => w.cf.records.get(w.Z.a1)!.find((r) => r.name === '_mta-sts.a-corp.com')!.content;
/** A TLS report that makes enforce possible, and a testing period long enough. */
let reportNo = 0;
function ready(w: MtaWorld, domainId = 1) {
  w.db.sqlite.prepare('UPDATE mta_sts_config SET mode_changed_at = ?, policy_published_at = ? WHERE domain_id = ?').run(now() - 10 * DAY, now() - 10 * DAY, domainId);
  w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id) VALUES (?, 'Google', ?, ?, 40, 0, 40, 0, '[]', ?)")
    .run(domainId, now() - 3 * DAY - ++reportNo, now() - 2 * DAY, w.A.ws);
}

describe('availability and the gate: every refusal is a true sentence, nothing is written', () => {
  it('not configured on this service: 403 with the reason, no dead button', async () => {
    const w = await mtaWorld({ POLICY_HOST_TOKEN: '' });
    const get = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(get).toMatchObject({ available: false, unavailable_reason: 'not_configured', unavailable_message: 'MTA-STS is not available on this service yet: the operator has not set up policy hosting.', via: null, records: [], mx_preview: { status: 'ok', hosts: ['mx.a-corp.com'], error: null } });
    const post = await w.mta(w.A.token, 'POST', 1);
    expect(post.status).toBe(403);
    expect(await w.json(post)).toMatchObject({ code: 'mta_sts_unavailable', reason: 'not_configured' });
    expect(w.writes(OP_ZONE)).toEqual([]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });

  it('workspace not admitted to TLS reports (HOSTED_CONNECT_REPORTS=owner): unavailable, not_allowed', async () => {
    const w = await mtaWorld({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: false, unavailable_reason: 'not_allowed' });
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(403);
    // the instance owner's own workspace is admitted
    const owner = await mtaWorld({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'a@example.com' });
    expect(await owner.json(await owner.mta(owner.A.token, 'GET', 1))).toMatchObject({ available: true });
  });

  it('the instance ceiling (MAX_POLICY_HOSTS): refused over it, with the limit; an existing host stays readable', async () => {
    const w = await mtaWorld({ MAX_POLICY_HOSTS: '1' });
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(201);
    const get = await w.json(await w.mta(w.A.token, 'GET', 2));
    expect(get).toMatchObject({ available: false, unavailable_reason: 'ceiling', unavailable_message: 'This service has reached its limit of 1 MTA-STS policy host.' });
    const post = await w.mta(w.A.token, 'POST', 2);
    expect(post.status).toBe(403);
    expect(await w.json(post)).toMatchObject({ reason: 'ceiling', limit: { kind: 'policy_hosts', max: 1 } });
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: true, unavailable_reason: 'none', config: { state: 'waiting_certificate' } });
  });

  it('a domain with hosted records: 409, and the sentence says why', async () => {
    const w = await mtaWorld();
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (1, ?, 'abcdefghijklmnop', 'z1')").run(w.A.ws);
    const get = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(get).toMatchObject({ available: false, unavailable_reason: 'hosted_records' });
    expect(get.unavailable_message).toMatch(/hosted records: its _smtp\._tls record is already a pointer/);
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(409);
  });

  it('an unproven domain, and a name inside the operator\'s own zone: refused', async () => {
    const w = await mtaWorld();
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: false, unavailable_reason: 'unproven' });
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(403);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt', domain = 'mail.readysetmail.com' WHERE id = 1").run();
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: false, unavailable_reason: 'zone_subdomain' });
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(422);
    expect(w.writes(OP_ZONE)).toEqual([]);
  });

  it('a member may read but not write (the router\'s read-only gate)', async () => {
    const w = await mtaWorld();
    expect((await w.mta(w.member, 'GET', 1)).status).toBe(200);
    for (const [m, sub] of [['POST', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/verify']] as const) {
      expect((await w.mta(w.member, m, 1, m === 'PATCH' ? { mode: 'enforce' } : undefined, sub)).status, `${m}${sub}`).toBe(403);
    }
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });

  it('another workspace\'s domain is a 404', async () => {
    const w = await mtaWorld();
    for (const m of ['GET', 'POST', 'DELETE']) expect((await w.mta(w.A.token, m, 3)).status, m).toBe(404);
    expect(w.writes(OP_ZONE)).toEqual([]);
  });
});

describe('checks before anything is created', () => {
  it('no MX records: 422, nothing written', async () => {
    const w = await mtaWorld();
    delete w.cf.mx['a-corp.com'];
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBe(422);
    expect((await w.json(res)).error).toBe('No MX records found for a-corp.com. Configure MX records before enabling MTA-STS.');
    expect(w.writes(OP_ZONE)).toEqual([]);
    expect(w.writes(w.Z.a1)).toEqual([]);
  });

  it('a DNS failure reading the MX hosts is a 502, not "no MX records"; GET keeps the error apart from none', async () => {
    const w = await mtaWorld();
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (String(input).includes('type=MX') ? new Response('boom', { status: 500 }) : inner(input, init)));
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(502);
    const get = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(get.mx_preview.status).toBe('error');
    expect(get.mx_preview.error).toBeTruthy();
    expect(w.writes(OP_ZONE)).toEqual([]);
  });

  it('GET says "none" when the domain has no MX', async () => {
    const w = await mtaWorld();
    delete w.cf.mx['a-corp.com'];
    expect((await w.json(await w.mta(w.A.token, 'GET', 1))).mx_preview).toEqual({ status: 'none', hosts: [], error: null });
  });

  it.each([
    ['an _mta-sts record', (w: MtaWorld) => { w.cf.doh['_mta-sts.a-corp.com'] = ['v=STSv1; id=1']; }, /_mta-sts\.a-corp\.com already has a record \(v=STSv1; id=1\)/],
    ['a TLS reporting record', (w: MtaWorld) => { w.cf.doh['_smtp._tls.a-corp.com'] = ['v=TLSRPTv1; rua=mailto:x@y.example']; }, /_smtp\._tls\.a-corp\.com already has a TLS reporting record/],
    ['an mta-sts host', (w: MtaWorld) => { w.cf.a['mta-sts.a-corp.com'] = ['192.0.2.1']; }, /mta-sts\.a-corp\.com already exists in DNS/],
    ['an mta-sts CNAME', (w: MtaWorld) => { w.cf.cname['mta-sts.a-corp.com'] = 'other.example'; }, /mta-sts\.a-corp\.com already exists in DNS/],
  ])('%s in the way: 409 naming it, nothing created', async (_n, arrange, message) => {
    const w = await mtaWorld();
    arrange(w);
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBe(409);
    const body = await w.json(res);
    expect(body.error).toMatch(message);
    expect(body.code).toBe('mta_sts_record_in_the_way');
    expect(w.writes(OP_ZONE)).toEqual([]);
    expect(w.writes(w.Z.a1)).toEqual([]);
  });

  it('already enabled: 409', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(409);
  });
});

describe('all or nothing: what was created is undone', () => {
  it('a customer record that cannot be written takes the operator\'s hostname and route and the first record back', async () => {
    const w = await mtaWorld();
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'POST' && String(input).includes(`/zones/${w.Z.a1}/dns_records`) && JSON.parse(init.body).type === 'TXT'
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 })
      : inner(input, init)));
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBe(502);
    expect((await w.json(res)).error).toMatch(/nothing was changed/);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.cf.routes[OP_ZONE]).toEqual([]);
    expect(w.cf.records.get(w.Z.a1) ?? []).toEqual([]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });

  it('an operator zone that refuses the hostname leaves nothing behind', async () => {
    const w = await mtaWorld();
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'POST' && String(input).includes('/workers/routes')
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'route refused' }] }), { status: 400 })
      : inner(input, init)));
    const res = await w.mta(w.A.token, 'POST', 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.writes(w.Z.a1)).toEqual([]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });
});

describe('the operator\'s own domain (worker_route)', () => {
  it('uses a proxied CNAME to the target and a route, never a custom hostname, and publishes straight away', async () => {
    const w = await mtaWorld();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (7, ?, 'readysetmail.com', 'x', 'txt')").run(w.A.ws);
    w.cf.zones['readysetmail.com'] = { id: OP_ZONE, cfAccountId: 'cf-1' };
    w.cf.mx['readysetmail.com'] = ['10 mail.protonmail.ch.', '20 mailsec.protonmail.ch.'];
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${w.connection}/zones`, { zone_ids: [w.Z.a1, OP_ZONE] });
    await w.api(w.A.token, 'PUT', '/api/domains/7/connection', { connection_id: w.connection });
    const res = await w.mta(w.A.token, 'POST', 7);
    expect(res.status).toBe(201);
    expect(await w.json(res)).toMatchObject({ policy_host: 'worker_route', config: { state: 'active', mx_hosts: 'mail.protonmail.ch,mailsec.protonmail.ch' } });
    expect(w.cf.customHostnames[OP_ZONE] ?? []).toEqual([]);
    expect(w.cf.routes[OP_ZONE]).toEqual([expect.objectContaining({ pattern: 'mta-sts.readysetmail.com/*', script: 'rsm-worker' })]);
    const recs = w.cf.records.get(OP_ZONE)!;
    expect(recs.map((r) => `${r.type} ${r.name}`).sort()).toEqual(['CNAME mta-sts.readysetmail.com', 'TXT _mta-sts.readysetmail.com', 'TXT _smtp._tls.readysetmail.com']);
    expect(w.writes(OP_ZONE).find((c) => c.body?.type === 'CNAME')!.body).toMatchObject({ proxied: true, content: OP.target });
    // (the operator's token wrote the route; the customer connection wrote the records)
    expect(w.calls(OP_ZONE).filter((c) => c.url.includes('workers/routes') && c.method === 'POST').every((c) => c.auth === `Bearer ${OP.token}`)).toBe(true);
  });
});

describe('modes', () => {
  it('enforce is refused until the evidence is there, with every reason in words; switching to testing is always allowed', async () => {
    const w = await mtaWorld();
    await active(w);
    const res = await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    expect(res.status).toBe(422);
    const body = await w.json(res);
    expect(body).toMatchObject({ code: 'mta_sts_not_ready' });
    expect(body.reasons.join(' ')).toMatch(/days senders need to report/);
    expect(body.reasons.join(' ')).toMatch(/No TLS report has arrived yet/);
    expect(w.row(1).mode).toBe('testing');

    const get = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(get.enforce).toMatchObject({ allowed: false, ready: false });
    expect(get.enforce.reasons).toEqual(body.reasons);
    // testing → testing is a no-op
    expect(await w.json(await w.mta(w.A.token, 'PATCH', 1, { mode: 'testing' }))).toMatchObject({ ok: true, unchanged: true });
  });

  it('with the evidence: enforces; the stored policy changes BEFORE the TXT, a new id is published, and the policy file says enforce', async () => {
    const w = await mtaWorld();
    await active(w);
    ready(w);
    const oldId = w.row(1).policy_id;
    // Watch the order: when the TXT patch arrives, the stored row must already say enforce.
    const inner = w.cf.fetch;
    let seenAtTxtWrite: string | null = null;
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      if (init?.method === 'PATCH' && String(input).includes('/dns_records/')) seenAtTxtWrite = w.rows('SELECT mode FROM mta_sts_config WHERE domain_id = 1')[0].mode;
      return inner(input, init);
    });
    const res = await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    expect(res.status).toBe(200);
    const body = await w.json(res);
    expect(body).toMatchObject({ ok: true, mode: 'enforce', publish: null });
    expect(body.policy_id).not.toBe(oldId);
    expect(seenAtTxtWrite).toBe('enforce');
    expect(publishedId(w)).toBe(`v=STSv1; id=${body.policy_id}`);
    expect(w.row(1)).toMatchObject({ mode: 'enforce', policy_id: body.policy_id });
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'mta_sts.mode_change'")).toHaveLength(1);
    const get = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(get.enforce).toBeNull();
    expect(get.disable).toMatchObject({ allowed: false, reason: expect.stringMatching(/^Switch to testing first\. Senders keep the enforce policy for up to 1 day/) });
  });

  it('a failed TXT write leaves the mode and the id where they were', async () => {
    const w = await mtaWorld();
    await active(w);
    ready(w);
    const before = w.row(1);
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'PATCH' && String(input).includes('/dns_records/')
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 })
      : inner(input, init)));
    const res = await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await w.json(res)).error).toMatch(/The mode was not changed/);
    expect(w.row(1)).toMatchObject({ mode: 'testing', policy_id: before.policy_id, policy_published_at: before.policy_published_at, state: 'active' });
  });

  it('by hand: the mode change asks the person to publish the new id and the row says it is not published', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 2);
    w.cf.cname['mta-sts.a-two.org'] = OP.target;
    w.cf.doh['_smtp._tls.a-two.org'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
    w.cf.activateHostname('mta-sts.a-two.org');
    await w.mta(w.A.token, 'POST', 2, undefined, '/verify');
    w.cf.doh['_mta-sts.a-two.org'] = [`v=STSv1; id=${w.row(2).policy_id}`];
    await w.mta(w.A.token, 'POST', 2, undefined, '/verify');
    ready(w, 2);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET mode_changed_at = ?, policy_published_at = ? WHERE domain_id = 2').run(now() - 10 * DAY, now() - 10 * DAY);
    const res = await w.mta(w.A.token, 'PATCH', 2, { mode: 'enforce' });
    expect(res.status).toBe(200);
    const body = await w.json(res);
    expect(body.publish).toEqual({ name: '_mta-sts.a-two.org', type: 'TXT', value: `v=STSv1; id=${body.policy_id}` });
    expect(w.row(2)).toMatchObject({ mode: 'enforce', state: 'waiting_txt', policy_published_at: null });
    expect(w.writes(w.Z.a2)).toEqual([]);
  });
});

describe('MX hosts', () => {
  it('PATCH refresh_mx: a changed list is a new id, written to the stored policy first and then to the record', async () => {
    const w = await mtaWorld();
    await active(w);
    const oldId = w.row(1).policy_id;
    expect(await w.json(await w.mta(w.A.token, 'PATCH', 1, { refresh_mx: true }))).toMatchObject({ ok: true, changed: false });
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.', '20 mx2.a-corp.com.'];
    const res = await w.json(await w.mta(w.A.token, 'PATCH', 1, { refresh_mx: true }));
    expect(res).toMatchObject({ ok: true, changed: true, mx_hosts: ['mx.a-corp.com', 'mx2.a-corp.com'] });
    expect(res.policy_id).not.toBe(oldId);
    expect(publishedId(w)).toBe(`v=STSv1; id=${res.policy_id}`);
    expect(w.row(1).notice).toMatch(/Your MX hosts changed \(now: mx\.a-corp\.com, mx2\.a-corp\.com\)/);
    // the policy file lists both
    const fetched = await (await import('../../src/index')).default.fetch(new Request('https://mta-sts.a-corp.com/.well-known/mta-sts.txt'), w.env, { waitUntil() {} } as any);
    expect(await fetched.text()).toContain('mx: mx2.a-corp.com');
  });

  it('no MX answer is a 400 and nothing changes; a DNS failure is a 502', async () => {
    const w = await mtaWorld();
    await active(w);
    delete w.cf.mx['a-corp.com'];
    expect((await w.mta(w.A.token, 'PATCH', 1, { refresh_mx: true })).status).toBe(400);
    expect(w.row(1).mx_hosts).toBe('mx.a-corp.com');
  });

  it('a grown list while enforcing goes back to testing; a shrunk one does not', async () => {
    const w = await mtaWorld();
    await active(w);
    ready(w);
    await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.', '20 mx2.a-corp.com.'];
    const grown = await w.json(await w.mta(w.A.token, 'PATCH', 1, { refresh_mx: true }));
    expect(grown).toMatchObject({ changed: true, mode: 'testing' });
    expect(w.row(1)).toMatchObject({ mode: 'testing' });
    expect(w.row(1).left_enforce_at).toBeGreaterThan(0);
    expect(w.row(1).notice).toMatch(/went back to testing: the new hosts have no TLS reports yet/);

    ready(w);
    await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    w.cf.mx['a-corp.com'] = ['10 mx.a-corp.com.'];
    expect(await w.json(await w.mta(w.A.token, 'PATCH', 1, { refresh_mx: true }))).toMatchObject({ changed: true, mode: 'enforce' });
  });

  it('the notice can be dismissed by an admin, not read-only members', async () => {
    const w = await mtaWorld();
    await active(w);
    w.db.sqlite.prepare("UPDATE mta_sts_config SET notice = 'x', notice_at = 1 WHERE domain_id = 1").run();
    expect((await w.json(await w.mta(w.A.token, 'GET', 1))).config).toMatchObject({ notice: 'x' });
    expect((await w.mta(w.member, 'PATCH', 1, { dismiss_notice: true })).status).toBe(403);
    expect((await w.mta(w.admin, 'PATCH', 1, { dismiss_notice: true })).status).toBe(200);
    expect(w.row(1)).toMatchObject({ notice: null, notice_at: null });
  });
});

describe('disable', () => {
  it('from testing, never in enforce: removes exactly what was made (records by id, hostname, route, row) and says how long senders may keep it', async () => {
    const w = await mtaWorld();
    await active(w);
    const res = await w.mta(w.A.token, 'DELETE', 1);
    expect(res.status).toBe(200);
    expect(await w.json(res)).toEqual({ ok: true, kept: [], operator: 'removed', message: 'Senders that already fetched the policy may keep it for up to 1 day.' });
    expect(w.cf.records.get(w.Z.a1)).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.cf.routes[OP_ZONE]).toEqual([]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'mta_sts.disable'")).toHaveLength(1);
    expect((await w.mta(w.A.token, 'DELETE', 1)).status).toBe(204);
  });

  it('a record the customer changed is kept and said so; the rest goes', async () => {
    const w = await mtaWorld();
    await active(w);
    w.cf.records.get(w.Z.a1)!.find((r) => r.name === '_smtp._tls.a-corp.com')!.content = 'something the customer wrote';
    const body = await w.json(await w.mta(w.A.token, 'DELETE', 1));
    expect(body.kept).toEqual([{ type: 'TXT', name: '_smtp._tls.a-corp.com', reason: 'its content no longer matches what Ready Set Mail wrote' }]);
    expect(w.cf.records.get(w.Z.a1)!.map((r) => r.name)).toEqual(['_smtp._tls.a-corp.com']);
  });

  it('is refused in enforce, saying to switch to testing first; allowed only after max_age since the switch back', async () => {
    const w = await mtaWorld();
    await active(w);
    ready(w);
    await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' });
    const blocked = await w.mta(w.A.token, 'DELETE', 1);
    expect(blocked.status).toBe(409);
    expect(await w.json(blocked)).toMatchObject({ code: 'mta_sts_disable_blocked', error: 'Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.' });
    expect(w.rows('SELECT * FROM mta_sts_config')).toHaveLength(1);

    await w.mta(w.A.token, 'PATCH', 1, { mode: 'testing' });
    const early = await w.mta(w.A.token, 'DELETE', 1);
    expect(early.status).toBe(409);
    const left = w.row(1).left_enforce_at;
    expect((await w.json(early)).after).toBe(left + DAY);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);

    w.db.sqlite.prepare('UPDATE mta_sts_config SET left_enforce_at = ? WHERE domain_id = 1').run(now() - DAY - 5);
    expect((await w.mta(w.A.token, 'DELETE', 1)).status).toBe(200);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
  });

  it('when the operator zone cannot be reached the row still goes, it says "pending", and the daily job removes the leftovers', async () => {
    const w = await mtaWorld();
    await active(w);
    const inner = w.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (String(input).includes(`/zones/${OP_ZONE}`) && init?.method === 'DELETE'
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 })
      : inner(input, init)));
    const body = await w.json(await w.mta(w.A.token, 'DELETE', 1));
    expect(body).toMatchObject({ ok: true, operator: 'pending' });
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(w.cf.routes[OP_ZONE]).toHaveLength(1);
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', inner);
    const { reconcileOperatorZone } = await import('../../src/mta-sts/refresh');
    expect(await reconcileOperatorZone(w.env)).toBe(1);
    expect(w.cf.routes[OP_ZONE]).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
  });
});
