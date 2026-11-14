import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

// GET /api/domains/:id/dns-check `cf_managed`: can the product write this domain's DNS ("Apply via Cloudflare")?
// Decided by whether the domain's own zone is reachable, never by the report authorization record (dns_record_id).

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

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function makeEnv(token: string | undefined = 'cf-token'): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id) VALUES (1, ?, ?, NULL), (2, ?, ?, ?)')
    .run('acme.com', 'rua@reports.acme.com', 'unmanaged.net', 'rua@reports.acme.com', 'auth-record-in-reports-zone');
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: token } as Env;
}

const check = async (id: number, env: Env) =>
  (await (await handleApi(new Request(`https://x.test/api/domains/${id}/dns-check`, { headers: { 'x-api-key': 'k' } }), env, ctx)).json()) as { found: boolean; cf_managed: boolean };

let cf: FakeCloudflare;
beforeEach(() => {
  cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } }));
  cf.doh['_dmarc.acme.com'] = ['v=DMARC1; p=none'];
  cf.doh['_dmarc.unmanaged.net'] = ['v=DMARC1; p=none'];
});
afterEach(() => vi.unstubAllGlobals());

describe('dns-check cf_managed', () => {
  it('true for a domain whose zone is on the account, even without an authorization record', async () => {
    expect(await check(1, makeEnv())).toMatchObject({ found: true, cf_managed: true });
  });

  it('false for a domain whose zone is not on the account, even with an authorization record stored', async () => {
    expect(await check(2, makeEnv())).toMatchObject({ found: true, cf_managed: false });
  });

  it('false without any Cloudflare credentials', async () => {
    expect(await check(1, makeEnv(''))).toMatchObject({ cf_managed: false });
  });
});
