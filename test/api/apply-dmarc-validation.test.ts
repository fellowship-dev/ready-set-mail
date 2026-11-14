import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

// POST /api/domains/:id/apply-dmarc writes only one well-formed DMARC record, only at _dmarc.<that domain>.

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'auth-rec-1', recordName: 'x', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';
import { dmarcRecordProblem } from '../../src/dmarc/dns-record';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function makeEnv(): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id) VALUES (1, ?, ?, ?)').run('acme.com', 'rua@reports.acme.com', 'have-one');
  seedSettings(db, {
    base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com',
    zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct',
  });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
}

const apply = (record: unknown) => new Request('https://x.test/api/domains/1/apply-dmarc', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
  body: JSON.stringify({ record }),
});

let cf: FakeCloudflare;
beforeEach(() => { cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } })); });
afterEach(() => vi.unstubAllGlobals());

describe('apply-dmarc content validation', () => {
  const refused: [string, unknown][] = [
    ['not DMARC', 'hello'],
    ['SPF content', 'v=spf1 -all'],
    ['lower-case version', 'v=dmarc1; p=none'],
    ['no policy', 'v=DMARC1; rua=mailto:a@b.test'],
    ['unknown policy', 'v=DMARC1; p=monitor'],
    ['v= not first', 'p=none; v=DMARC1'],
    ['a quote that ends the TXT string', 'v=DMARC1; p=none" "x'],
    ['a backslash', 'v=DMARC1; p=none; rua=mailto:a\\@b.test'],
    ['a newline', 'v=DMARC1; p=none\nv=spf1 -all'],
    ['a control character', 'v=DMARC1; p=none\u0000'],
    ['a duplicated tag', 'v=DMARC1; p=none; p=reject'],
    ['bad adkim', 'v=DMARC1; p=none; adkim=x'],
    ['pct over 100', 'v=DMARC1; p=none; pct=101'],
    ['rua that is not mailto', 'v=DMARC1; p=none; rua=https://evil.test'],
    ['empty rua address', 'v=DMARC1; p=none; rua=mailto:'],
    ['a part without =', 'v=DMARC1; p=none; junk'],
    ['too long', `v=DMARC1; p=none; rua=${Array.from({ length: 60 }, (_, i) => `mailto:a${i}@reports.example.test`).join(',')}`],
    ['not a string', { evil: true }],
  ];
  it.each(refused)('refuses %s with 400 and writes nothing', async (_t, record) => {
    const res = await handleApi(apply(record), makeEnv(), ctx);
    expect(res.status).toBe(400);
    expect(cf.calls).toHaveLength(0);
  });

  it('accepts a full record with every known tag and an unknown one', async () => {
    const record = 'v=DMARC1; p=quarantine; sp=reject; np=reject; adkim=s; aspf=r; pct=100; t=n; fo=0:1:d:s; rf=afrf; ri=86400; rua=mailto:a@b.test!10m,mailto:c@d.test; ruf=mailto:e@f.test; x-new=whatever;';
    expect(dmarcRecordProblem(record)).toBeNull();
    const res = await handleApi(apply(record), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(cf.records.get('zone-acme')).toEqual([expect.objectContaining({ name: '_dmarc.acme.com', content: record })]);
  });

  it('says what is wrong in plain words', async () => {
    const res = await handleApi(apply('v=DMARC1; p=monitor'), makeEnv(), ctx);
    expect(await res.json()).toEqual({ error: 'Not a valid DMARC record: p=monitor is not a valid value' });
  });

  it('updates the DMARC record in place, not another TXT at the same name, and refuses two DMARC records (409)', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'some-verification=1' });
    const dmarc = cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' });
    expect((await handleApi(apply('v=DMARC1; p=reject'), makeEnv(), ctx)).status).toBe(200);
    expect(cf.records.get('zone-acme')!.map(r => r.content)).toEqual(['some-verification=1', 'v=DMARC1; p=reject']);
    expect(cf.calls.find(c => c.method === 'PATCH')!.url).toContain(dmarc.id);

    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' });
    const res = await handleApi(apply('v=DMARC1; p=quarantine'), makeEnv(), ctx);
    expect(res.status).toBe(409);
    expect(cf.calls.filter(c => c.method !== 'GET')).toHaveLength(1);
  });

  it('passes the apex guard to the write policy: the write may land only on _dmarc.<domain>', async () => {
    const existing = cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' });
    await handleApi(apply('v=DMARC1; p=reject'), makeEnv(), ctx);
    const patch = cf.calls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toContain(existing.id);
    expect(patch.body).toEqual({ type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=reject' });
  });
});
