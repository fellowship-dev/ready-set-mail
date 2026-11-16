// The SPF flattening routes end to end on a self-hosted instance (fake Cloudflare and fake provider DNS): turn on, state, check now, preview, Replace, turn off.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error { constructor(msg: string, public status = 401) { super(msg); } },
}));
vi.mock('../../src/dns/provision', () => ({ provisionDomain: vi.fn(), deprovisionDomain: vi.fn(), DnsProvisionError: class extends Error {} }));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';
import { handleApi } from '../../src/api/router';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const ORIGINAL = 'v=spf1 include:mail.test include:other.test -all';

function setup() {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'rua@reports.test.com')").run();
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.test.com', from_email: 'noreply@reports.test.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf' });
  const cf = new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf' } });
  cf.realisticTxt = true;
  cf.seed('zone-acme', { id: 'spf-acme', type: 'TXT', name: 'acme.com', content: ORIGINAL });
  cf.doh['acme.com'] = [ORIGINAL];
  cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.0/28 ~all'];
  cf.doh['other.test'] = ['v=spf1 ip4:203.0.113.9 -all'];
  stubCloudflare(cf);
  const env = { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'cf', CLOUDFLARE_ZONE_ID: 'zone-acme' } as never;
  const send = (method: string, path: string, body?: unknown) => handleApi(new Request(`https://api.test${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { db, cf, send, live: () => decodeTxtData(cf.records.get('zone-acme')![0]!.content) };
}
afterEach(() => vi.unstubAllGlobals());

describe('SPF flattening routes', () => {
  it('preview, turn on, state, check now, turn off', async () => {
    const w = setup();
    const pre = await (await w.send('GET', '/api/domains/1/spf-flatten/preview')).json() as any;
    expect(pre).toMatchObject({ original: ORIGINAL, within_limits: true, problem: null });
    expect(pre.flat).toMatchObject({ record: 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all', lookups_before: 2, lookups_after: 0 }); // within limits: what "Flatten anyway" would write

    const on = await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    expect(on.status).toBe(201);
    const body = await on.json() as any;
    expect(body.config).toMatchObject({ enabled: true, original_record: ORIGINAL, flattened_record: 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all', ip_count: 2, lookups_before: 2, lookups_after: 0, problem: null });
    expect(Object.keys(body.config)).not.toContain('workspace_id');
    expect(w.live()).toBe(body.config.flattened_record);

    expect(((await (await w.send('POST', '/api/domains/1/spf-flatten', {})).json()) as any).error).toMatch(/already on/);

    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    const check = await w.send('POST', '/api/domains/1/spf-flatten/refresh', {});
    // the new address is written at once; the old one waits for a second look (ADR 0024)
    expect(await check.json()).toMatchObject({ ok: true, outcome: 'changed', config: { previous_record: 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all', flattened_record: 'v=spf1 ip4:192.0.2.50 ip4:198.51.100.0/28 ip4:203.0.113.9 -all', pending: { providers: ['mail.test'], additions_written: true } } });
    expect(w.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'spf_flatten.update'").get().n).toBe(1);

    // an apply-spf by hand is refused while it is on, with the true reason
    const hand = await w.send('POST', '/api/domains/1/apply-spf', { record: 'v=spf1 ip4:1.1.1.1 -all' });
    expect(hand.status).toBe(409);
    expect(((await hand.json()) as any).error).toBe('SPF flattening is on for this domain. Turn it off before editing the SPF record here.');

    const off = await w.send('DELETE', '/api/domains/1/spf-flatten');
    expect(off.status).toBe(204);
    expect(w.live()).toBe(ORIGINAL);
    expect(((await (await w.send('GET', '/api/domains/1/spf-flatten')).json()) as any).config).toBeNull();
  });

  it('an edit made in Cloudflare is shown as a problem and Replace puts the fresh record back', async () => {
    const w = setup();
    await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    w.cf.records.get('zone-acme')![0]!.content = 'v=spf1 include:someone-else.test -all';
    const check = await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', {})).json() as any;
    expect(check.outcome).toBe('problem');
    expect(check.config.problem).toMatchObject({ kind: 'edited_outside', message: expect.stringMatching(/someone changed it there/) });
    const replaced = await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', { replace: true })).json() as any;
    expect(replaced).toMatchObject({ outcome: 'changed', config: { problem: null } });
    expect(w.live()).toBe('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all');
  });

  it('turning off over an outside edit answers 200 and says the record was left as it is', async () => {
    const w = setup();
    await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    w.cf.records.get('zone-acme')![0]!.content = 'v=spf1 include:someone-else.test -all';
    const off = await w.send('DELETE', '/api/domains/1/spf-flatten');
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, restored: false, why: 'edited_outside' });
    expect(w.live()).toBe('v=spf1 include:someone-else.test -all');
  });

  it('a refusal is a 422 with the kind and one sentence; nothing is written', async () => {
    const w = setup();
    delete w.cf.doh['other.test'];
    const res = await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'include_unresolved', error: expect.stringContaining('other.test') });
    expect(w.live()).toBe(ORIGINAL);
    expect(w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM spf_flatten_config').get().n).toBe(0);
  });

  it('Check again now holds a removal until four hours have passed since it was first seen, and says when', async () => {
    const w = setup();
    await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    const first = await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', {})).json() as any;
    const held = 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all';
    expect(first).toMatchObject({ ok: true, outcome: 'pending', config: { flattened_record: held, pending: { providers: ['mail.test'] } } });
    const at = first.config.pending.confirm_after as number;
    expect(first.message).toBe(`mail.test no longer lists 1 address. We are keeping it in your record until a second check agrees, which can happen after ${new Date(at * 1000).toISOString().slice(11, 16)} UTC${new Date().toISOString().slice(0, 10) === new Date(at * 1000).toISOString().slice(0, 10) ? '' : ' on ' + new Date(at * 1000).getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date(at * 1000).getUTCMonth()]}.`);
    expect(w.live()).toBe(held);

    // 3 hours later: still held, and it says so
    const setSince = (secondsAgo: number) => w.db.sqlite.prepare('UPDATE spf_flatten_config SET pending_since = ?, last_attempt_at = NULL').run(Math.floor(Date.now() / 1000) - secondsAgo);
    setSince(3 * 3600);
    const again = await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', {})).json() as any;
    expect(again).toMatchObject({ outcome: 'pending', config: { flattened_record: held } });
    expect(again.message).toMatch(/after \d\d:\d\d UTC/);
    expect(w.live()).toBe(held);

    // 5 hours after the first look: confirmed and written, and nothing is pending
    setSince(5 * 3600);
    const done = await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', {})).json() as any;
    expect(done).toMatchObject({ ok: true, outcome: 'changed', config: { flattened_record: 'v=spf1 ip4:203.0.113.9 -all', pending: null } });
    expect(done.message).toBeUndefined();
    expect(w.live()).toBe('v=spf1 ip4:203.0.113.9 -all');
  });

  it('an edit made in Cloudflare: POST /spf-flatten/adopt keeps it as the new original; where flattening is not on it is 404', async () => {
    const w = setup();
    expect((await w.send('POST', '/api/domains/1/spf-flatten/adopt', {})).status).toBe(404);
    await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    w.cf.records.get('zone-acme')![0]!.content = '"v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 ip4:192.0.2.9 -all"';
    expect((await (await w.send('POST', '/api/domains/1/spf-flatten/refresh', {})).json() as any).config.problem.kind).toBe('edited_outside');
    const r = await w.send('POST', '/api/domains/1/spf-flatten/adopt', {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, config: { original_record: 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 ip4:192.0.2.9 -all', problem: null } });
    expect((await w.send('GET', '/api/domains/1/spf-flatten/adopt')).status).toBe(405);
  });

  it('GET /spf-lookups: where the lookups go, term by term; the original while flattening is on', async () => {
    const w = setup();
    const before = await (await w.send('GET', '/api/domains/1/spf-lookups')).json() as any;
    expect(before).toMatchObject({ ok: true, source: 'published', record: ORIGINAL, total: 2, items: [{ term: 'include:mail.test', kind: 'include', cost: 1 }, { term: 'include:other.test', kind: 'include', cost: 1 }] });
    await w.send('POST', '/api/domains/1/spf-flatten', { anyway: true });
    expect(await (await w.send('GET', '/api/domains/1/spf-lookups')).json()).toMatchObject({ ok: true, source: 'original', record: ORIGINAL, total: 2 });
    expect((await w.send('GET', '/api/domains/99/spf-lookups')).status).toBe(404);
    expect((await w.send('POST', '/api/domains/1/spf-lookups', {})).status).toBe(405);
  });
});
