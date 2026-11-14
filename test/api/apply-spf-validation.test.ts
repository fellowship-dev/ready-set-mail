import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

// POST /api/domains/:id/apply-spf accepts a complete, valid SPF record (RFC 7208), parsed with the shared parser:
// a terminal all, or a redirect= without all.

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';
import { spfApplyProblem } from '../../src/dns/spf-apply-check';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function makeEnv(): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address) VALUES (1, ?, ?)').run('acme.com', 'rua@reports.acme.com');
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
}

const apply = (record: unknown) => new Request('https://x.test/api/domains/1/apply-spf', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ record }),
});

let cf: FakeCloudflare;
beforeEach(() => { cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } })); });
afterEach(() => vi.unstubAllGlobals());

describe('apply-spf record validation', () => {
  const accepted = [
    'v=spf1 include:_spf.google.com ~all',
    'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 mx a:mail.acme.com -all',
    'v=spf1 redirect=_spf.provider.example',
    'v=spf1 include:_spf.google.com redirect=_spf.provider.example',
    'v=spf1 include:_spf.google.com -all exp=explain.acme.com',
    'V=SPF1 include:_spf.google.com ~all',
    'v=spf1 ip4:0.0.0.0/0 ip6:::1 ip6:::ffff:192.0.2.1 ip6:2001:db8:0:0:0:0:0:1/128 ip6:fe80::/10 -all',
  ];
  it.each(accepted)('applies %s', async (record) => {
    const res = await handleApi(apply(record), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(cf.records.get('zone-acme')).toEqual([expect.objectContaining({ name: 'acme.com', content: record })]);
  });

  const refused: [string, unknown, RegExp][] = [
    ['not SPF', 'hello', /must start with v=spf1/],
    ['incomplete (the old substring test passed it: "mallory" contains "all")', 'v=spf1 include:mallory.test', /must end with an all mechanism or a redirect= modifier/],
    ['+all', 'v=spf1 include:_spf.google.com +all', /must not use \+all/],
    ['a bare all (+ by default)', 'v=spf1 all', /must not use \+all/],
    ['?all (neutral)', 'v=spf1 include:_spf.google.com ?all', /must not use \?all: neutral protects nothing/],
    ['an IPv4 address out of range', 'v=spf1 ip4:999.1.1.1 -all', /"ip4:999.1.1.1" is not a valid IPv4 address or prefix/],
    ['an IPv4 prefix over 32', 'v=spf1 ip4:1.2.3.4/33 -all', /"ip4:1.2.3.4\/33" is not a valid IPv4/],
    ['an IPv4 address with three parts', 'v=spf1 ip4:1.2.3 -all', /not a valid IPv4/],
    ['an IPv6 address that is not one', 'v=spf1 ip6:zz -all', /"ip6:zz" is not a valid IPv6 address or prefix/],
    ['an IPv6 prefix over 128', 'v=spf1 ip6:2001:db8::/129 -all', /not a valid IPv6/],
    ['an IPv6 address with too many groups', 'v=spf1 ip6:1:2:3:4:5:6:7:8:9 -all', /not a valid IPv6/],
    ['ptr', 'v=spf1 ptr:acme.com -all', /must not use ptr: RFC 7208 says not to/],
    ['a bare ptr', 'v=spf1 ptr -all', /must not use ptr/],
    ['both all and redirect', 'v=spf1 include:_spf.google.com ~all redirect=_spf.provider.example', /both an all mechanism and redirect=: receivers ignore redirect=/],
    ['all not last', 'v=spf1 -all include:_spf.google.com', /must end with its all mechanism/],
    ['an unknown mechanism', 'v=spf1 foo:bar.test -all', /"foo:bar.test" is not an SPF mechanism/],
    ['include without a domain', 'v=spf1 include -all', /"include" needs a value/],
    ['two redirects', 'v=spf1 redirect=a.test redirect=b.test', /redirect= appears more than once/],
    ['a quote', 'v=spf1 include:"x.test" -all', /without quotes/],
    ['non-ASCII', 'v=spf1 include:exämple.test -all', /printable text/],
    ['not a string', ['v=spf1 -all'], /record must be a string/],
  ];
  it.each(refused)('refuses %s with a plain 400 and writes nothing', async (_t, record, message) => {
    const res = await handleApi(apply(record), makeEnv(), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(cf.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('trims the record before validating and publishes the trimmed text', async () => {
    const res = await handleApi(apply('  v=spf1 include:_spf.google.com -all \n'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { record: string }).record).toBe('v=spf1 include:_spf.google.com -all');
    expect(cf.records.get('zone-acme')).toEqual([expect.objectContaining({ content: 'v=spf1 include:_spf.google.com -all' })]);
  });

  it('spfApplyProblem (unit): null exactly for the accepted records', () => {
    for (const r of accepted) expect(spfApplyProblem(r), r).toBeNull();
  });
});
