// R2 items 3 and 4.
//
// 3. A setup that is not finished 7 days after it was turned on is stopped: the custom hostname goes, the slot is free, the row is off with one notice.
//    Cloudflare deletes a hostname that was not validated within 7 days anyway.
// 4. Losing proof, removing the domain and an eviction do not take the policy down at once. RFC 8461 section 8.3 (removal): "Publish a new policy with "mode" equal
//    to "none" and a small "max_age" (e.g., one day). Publish a new TXT record to trigger fetching of the new policy. When all previously served policies have
//    expired -- normally this is the time the previously published policy was last served plus that policy's "max_age" ... safely remove the TXT record and HTTPS
//    endpoint." Serving `none` needs no proof: it can only stop senders from refusing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import worker from '../../src/index';
import { withdrawProof } from '../../src/domains/proof-recheck';
import { refreshMtaStsHosted } from '../../src/mta-sts/refresh';
import { INTAKE, OP, OP_ZONE, mtaWorld, quietLogs, type MtaWorld } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const HOST = 'mta-sts.a-corp.com';

async function active(w: MtaWorld, id = 1, domain = 'a-corp.com') {
  await w.mta(w.A.token, 'POST', id);
  w.cf.cname[`mta-sts.${domain}`] = OP.target;
  w.cf.doh[`_smtp._tls.${domain}`] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
  w.cf.activateHostname(`mta-sts.${domain}`);
  await w.mta(w.A.token, 'POST', id, undefined, '/verify');
  expect(w.row(id).state).toBe('active');
}
/** Enforcing, with the counted report that allows it. */
async function enforcing(w: MtaWorld) {
  await active(w);
  w.db.sqlite.prepare('UPDATE mta_sts_config SET mode_changed_at = ?, policy_published_at = ? WHERE domain_id = 1').run(now() - 10 * DAY, now() - 10 * DAY);
  w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id, reporter_tier, reporter_identity) VALUES (1, 'Google', ?, ?, 40, 0, 40, 0, '[]', ?, 'counted', 'google')").run(now() - 3 * DAY, now() - 2 * DAY, w.A.ws);
  expect((await w.mta(w.A.token, 'PATCH', 1, { mode: 'enforce' })).status).toBe(200);
}
const policyAt = (w: MtaWorld, host = HOST) => worker.fetch(new Request(`https://${host}/.well-known/mta-sts.txt`), { ...w.env, ASSETS: { fetch: async () => new Response('x') } } as any, ctx);
const idRecord = (w: MtaWorld) => w.cf.records.get(w.Z.a1)?.find((r) => r.name === '_mta-sts.a-corp.com');
const retiring = (w: MtaWorld) => w.rows('SELECT * FROM mta_sts_retiring');
const NONE = 'version: STSv1\nmode: none\nmx: mx.a-corp.com\nmax_age: 86400\n';

describe('3. a setup nobody finishes releases its slot after 7 days', () => {
  const STOPPED = 'Setup was not finished within 7 days, so it was stopped. Turn it on again to restart.';

  it('a manual setup still waiting for its records on day 8: the custom hostname is deleted, the row is off with the notice, the slot is free', async () => {
    const w = await mtaWorld({ MAX_POLICY_HOSTS: '1' });
    expect((await w.mta(w.A.token, 'POST', 2)).status).toBe(201); // a-two.org: no connection reaches it, so by hand
    expect(w.row(2)).toMatchObject({ via: 'manual', state: 'waiting_records' });
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: false, unavailable_reason: 'ceiling' });
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 2').run(now() - 8 * DAY);
    await refreshMtaStsHosted(w.env);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.row(2)).toMatchObject({ enabled: 0, notice: STOPPED, ch_id: null, route_id: null, fetch_ok: null });
    expect(await w.json(await w.mta(w.A.token, 'GET', 1))).toMatchObject({ available: true }); // the slot is free again
    const view = await w.json(await w.mta(w.A.token, 'GET', 2));
    expect(view).toMatchObject({ config: null, setup_expired: { notice: STOPPED }, enforce: null });
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'mta_sts.setup_expired'")).toHaveLength(1);
  });

  it('a setup whose policy never passed the fetch (hosted, Cloudflare connection) is stopped too, and its records go with it', async () => {
    const w = await mtaWorld();
    w.cf.policyServer = () => new Response('Not found', { status: 404 });
    await w.mta(w.A.token, 'POST', 1);
    w.cf.activateHostname(HOST);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 1').run(now() - 8 * DAY);
    await refreshMtaStsHosted(w.env);
    expect(w.row(1)).toMatchObject({ enabled: 0, notice: STOPPED });
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.cf.records.get(w.Z.a1) ?? []).toEqual([]);
  });

  it('turning it on again restarts it (the stopped row is replaced), and the notice can be dismissed', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 2);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 2').run(now() - 8 * DAY);
    await refreshMtaStsHosted(w.env);
    expect((await w.mta(w.A.token, 'POST', 2)).status).toBe(201);
    expect(w.row(2)).toMatchObject({ enabled: 1, state: 'waiting_records', notice: null });
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 2').run(now() - 8 * DAY);
    await refreshMtaStsHosted(w.env);
    expect((await w.mta(w.admin, 'PATCH', 2, { dismiss_notice: true })).status).toBe(200);
    expect(w.rows('SELECT * FROM mta_sts_config WHERE domain_id = 2')).toEqual([]);
  });

  it('leaves alone: a setup of 6 days, and one that is finished (active), however old', async () => {
    const w = await mtaWorld();
    await active(w);
    await w.mta(w.A.token, 'POST', 2);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 1').run(now() - 30 * DAY);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET created_at = ? WHERE domain_id = 2').run(now() - 6 * DAY);
    await refreshMtaStsHosted(w.env);
    expect(w.rows('SELECT domain_id, enabled FROM mta_sts_config ORDER BY domain_id')).toEqual([{ domain_id: 1, enabled: 1 }, { domain_id: 2, enabled: 1 }]);
  });
});

describe('4. the policy is retired the RFC 8461 way, not taken down at once', () => {
  it('removing a domain that enforced: mode none (one day) is served, the id changes, the host stays 7 days, then everything goes', async () => {
    const w = await mtaWorld();
    await enforcing(w);
    const idBefore = idRecord(w)!.content;
    const res = await w.api(w.A.token, 'DELETE', '/api/domains/1');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, mta_sts: { retiring: true, enforced: true, reason: 'removed' } });
    expect(body.mta_sts.until).toBeGreaterThanOrEqual(now() + 7 * DAY - 5);
    expect(body.mta_sts.message).toBe('MTA-STS is being switched off. Senders that already fetched the enforce policy may refuse to deliver to mail servers that are not in it for up to 7 days.');
    // the domain is gone, and so is its config row; the policy is not
    expect(w.rows('SELECT * FROM domains WHERE id = 1')).toEqual([]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(retiring(w)).toMatchObject([{ domain: 'a-corp.com', reason: 'removed', mode_before: 'enforce', workspace_id: w.A.ws }]);
    const served = await policyAt(w);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(NONE);
    expect(idRecord(w)!.content).not.toBe(idBefore); // a new id: senders fetch the none policy
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    // before the time is up the daily job leaves it alone
    await refreshMtaStsHosted(w.env);
    expect(retiring(w)).toHaveLength(1);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    expect((await policyAt(w)).status).toBe(200);
    // after it: the hostname, the records and the entry go, and the policy host is a 404
    w.db.sqlite.prepare('UPDATE mta_sts_retiring SET retire_after = ?').run(now() - 1);
    await refreshMtaStsHosted(w.env);
    expect(retiring(w)).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
    expect(w.cf.records.get(w.Z.a1)).toEqual([]);
    expect((await policyAt(w)).status).toBe(404);
  });

  it('a domain that only ever tested: one day, and the notice says one day', async () => {
    const w = await mtaWorld();
    await active(w);
    const res = await w.api(w.A.token, 'DELETE', '/api/domains/1');
    const body = await res.json() as any;
    expect(body.mta_sts).toMatchObject({ retiring: true, enforced: false });
    expect(body.mta_sts.until).toBeGreaterThanOrEqual(now() + DAY - 5);
    expect(body.mta_sts.until).toBeLessThan(now() + 2 * DAY);
    expect(body.mta_sts.message).toBe('MTA-STS is being switched off. Senders that already fetched the policy may keep it for up to 1 day.');
  });

  it('a domain that left enforce a day ago still waits out the week (an enforce policy may still be cached)', async () => {
    const w = await mtaWorld();
    await enforcing(w);
    expect((await w.mta(w.A.token, 'PATCH', 1, { mode: 'testing' })).status).toBe(200);
    await w.api(w.A.token, 'DELETE', '/api/domains/1');
    const until = retiring(w)[0].retire_after;
    expect(until).toBeGreaterThanOrEqual(now() + 7 * DAY - 10);
  });

  it('a lost proof: the domain stays, serves none without proof, and the page says what senders may do meanwhile', async () => {
    const w = await mtaWorld();
    await enforcing(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', cf_name_servers = '[\"a.ns.cloudflare.com\"]', cf_zone_name = 'a-corp.com' WHERE id = 1").run();
    expect(await withdrawProof(w.env, { id: 1, workspace_id: w.A.ws, domain: 'a-corp.com', cf_zone_id: w.Z.a1, cf_zone_name: 'a-corp.com', cf_name_servers: '["a.ns.cloudflare.com"]', cf_account_id: 'cf-1', cf_connection_id: w.connection, proof_checked_at: null, proof_suspected_at: null }, 'cloudflare')).toBe(true);
    expect(w.rows('SELECT verified_via FROM domains WHERE id = 1')[0]).toMatchObject({ verified_via: 'legacy' });
    expect(retiring(w)).toMatchObject([{ reason: 'lost_proof', mode_before: 'enforce' }]);
    expect(await (await policyAt(w)).text()).toBe(NONE);
    const view = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(view).toMatchObject({ config: null, retiring: { reason: 'lost_proof', enforced: true, message: expect.stringContaining('up to 7 days') } });
    expect(view.retiring.until).toBeGreaterThan(now() + 6 * DAY);
  });

  it('an eviction: the new owner proves the name; the old holder\'s policy still serves none until it expires, and the new owner can enable at once', async () => {
    const w = await mtaWorld();
    await enforcing(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
    const added = await w.api(w.B.token, 'POST', '/api/domains', { domain: 'a-corp.com' });
    const { claim } = await added.json() as any;
    w.cf.doh['_readysetmail.a-corp.com'] = [claim.txt_value];
    expect((await w.api(w.B.token, 'POST', `/api/domains/claims/${claim.id}/verify`, {})).status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'a-corp.com'")).toEqual([{ workspace_id: w.B.ws }]);
    expect(w.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(retiring(w)).toMatchObject([{ domain: 'a-corp.com', reason: 'evicted', workspace_id: w.A.ws }]);
    expect(await (await policyAt(w)).text()).toBe(NONE);
    // the days pass: the entry goes, the policy host is a 404 (the new owner has not turned MTA-STS on)
    w.db.sqlite.prepare('UPDATE mta_sts_retiring SET retire_after = ?').run(now() - 1);
    await refreshMtaStsHosted(w.env);
    expect(retiring(w)).toEqual([]);
    expect((await policyAt(w)).status).toBe(404);
  });

  it('never published (setup unfinished): nothing was served, so it goes at once', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1); // waiting for the certificate: no id, no policy fetched by anyone
    const body = await (await w.api(w.A.token, 'DELETE', '/api/domains/1')).json() as any;
    expect(body.mta_sts).toBeUndefined();
    expect(retiring(w)).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toEqual([]);
  });

  it('turning MTA-STS on again while it retires takes the policy host back: the entry goes, the hostname stays', async () => {
    const w = await mtaWorld();
    await active(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', cf_name_servers = '[\"a.ns.cloudflare.com\"]', cf_zone_name = 'a-corp.com' WHERE id = 1").run();
    await withdrawProof(w.env, { id: 1, workspace_id: w.A.ws, domain: 'a-corp.com', cf_zone_id: w.Z.a1, cf_zone_name: 'a-corp.com', cf_name_servers: '["a.ns.cloudflare.com"]', cf_account_id: 'cf-1', cf_connection_id: w.connection, proof_checked_at: null, proof_suspected_at: null }, 'cloudflare');
    expect(retiring(w)).toHaveLength(1);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt' WHERE id = 1").run();
    expect((await w.mta(w.A.token, 'POST', 1)).status).toBe(201);
    expect(retiring(w)).toEqual([]);
    expect(w.cf.customHostnames[OP_ZONE]).toHaveLength(1);
    w.cf.activateHostname(HOST);
    await w.mta(w.A.token, 'POST', 1, undefined, '/verify');
    expect(w.row(1)).toMatchObject({ state: 'active', mode: 'testing' });
    expect(await (await policyAt(w)).text()).toBe('version: STSv1\nmode: testing\nmx: mx.a-corp.com\nmax_age: 86400\n');
  });

  it('the retiring hostname still counts against the ceiling until it is deleted', async () => {
    const w = await mtaWorld({ MAX_POLICY_HOSTS: '1' });
    await active(w);
    await w.api(w.A.token, 'DELETE', '/api/domains/1');
    expect(await w.json(await w.mta(w.A.token, 'GET', 2))).toMatchObject({ available: false, unavailable_reason: 'ceiling' });
    w.db.sqlite.prepare('UPDATE mta_sts_retiring SET retire_after = ?').run(now() - 1);
    await refreshMtaStsHosted(w.env);
    expect(await w.json(await w.mta(w.A.token, 'GET', 2))).toMatchObject({ available: true });
  });
});
