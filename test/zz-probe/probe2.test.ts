import { describe, it, vi, afterEach } from 'vitest';
import type { Env } from '../../src/index';

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

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

describe('PROBE bulk import cost', () => {
  for (const spfTerms of [0, 10]) {
    it(`50 domains, ${spfTerms} SPF includes each`, async () => {
      const doh: Record<string, string[]> = {};
      const names = Array.from({ length: 50 }, (_, i) => `s${i}.acme.com`);
      for (const n of names) {
        doh[n] = [spfTerms ? `v=spf1 ${Array.from({ length: spfTerms }, (_, j) => `include:i${j}.${n}`).join(' ')} -all` : 'v=spf1 -all'];
        doh[`_dmarc.${n}`] = ['v=DMARC1; p=none'];
        for (let j = 0; j < spfTerms; j++) doh[`i${j}.${n}`] = ['v=spf1 -all'];
      }
      const cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } }, undefined, undefined, doh));
      const db = createMigratedD1();
      seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
      const env = { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
      const t0 = performance.now();
      const res = await handleApi(new Request('https://x.test/api/domains/bulk-import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ domains: names.join('\n') }) }), env, ctx);
      const ms = performance.now() - t0;
      await Promise.all(pending.splice(0));
      const body: any = await res.json();
      const all = cf.fetch.mock.calls.map((c: any[]) => new URL(typeof c[0] === 'string' ? c[0] : c[0].url ?? String(c[0])).hostname);
      const dohCalls = all.filter((h) => h === 'cloudflare-dns.com').length;
      const checked = body.results.filter((r: any) => r.dns_checked).length;
      console.log('PROBE_BULK ' + JSON.stringify({ spfTerms, status: res.status, imported: body.imported, checked, totalFetches: all.length, dohCalls, cfApiCalls: all.length - dohCalls, ms: Math.round(ms) }));
    });
  }
});
