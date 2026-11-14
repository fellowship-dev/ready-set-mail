import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error { constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; } },
}));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: 'x', manual: true }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';
import { bareTxt, txtContent, dmarcRecordProblem, withPolicy } from '../../src/dmarc/dns-record';
import { spfApplyProblem } from '../../src/dns/spf-apply-check';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
let db: ReturnType<typeof createMigratedD1>;
let cf: FakeCloudflare;
function makeEnv(domains: { id: number; domain: string }[]): Env {
  db = createMigratedD1();
  for (const d of domains) db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dmarc_policy) VALUES (?, ?, ?, ?)').run(d.id, d.domain, 'rua@reports.acme.com', 'none');
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
}
const req = (path: string, method: string, body?: unknown) => new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call(r: Request, env: Env) { const res = await handleApi(r, env, ctx); await Promise.all(pending.splice(0)); return { status: res.status, body: await res.json().catch(() => null) as any }; }
const recs = (name: string) => (cf.records.get('zone-acme') ?? []).filter((r) => r.name === name).map((r) => r.content);
beforeEach(() => { cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } })); pending.length = 0; });
afterEach(() => vi.unstubAllGlobals());
const out: Record<string, unknown> = {};

const recordOfLength = (n: number) => {
  const base = 'v=DMARC1; p=none; rua=mailto:';
  const tail = '@vendor.example.com';
  return base + 'a'.repeat(n - base.length - tail.length) + tail;
};

describe('PROBE4 DMARC long records', () => {
  for (const n of [255, 256, 510, 511, 1000]) {
    it(`apply ${n} then patch`, async () => {
      const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
      const rec = recordOfLength(n);
      const a = await call(req('/api/domains/1/apply-dmarc', 'POST', { record: rec }), env);
      const stored = recs('_dmarc.acme.com');
      const p = await call(req('/api/domains/1/dmarc', 'PATCH', { policy: 'reject' }), env);
      const after = recs('_dmarc.acme.com');
      out[`len${n}`] = {
        apply: a.status, storedParts: stored.map((s) => (s.match(/"/g) ?? []).length / 2 || 1), storedMaxPart: Math.max(...stored[0].split('" "').map((x) => x.replace(/"/g, '').length)),
        patch: p.status, patchErr: p.body?.error, roundTrip: bareTxt(after[0] ?? '') === withPolicy(rec, 'reject', 'rua@reports.acme.com'), afterLen: bareTxt(after[0] ?? '').length, afterParts: (after[0] ?? '').split('" "').map((x) => x.replace(/"/g, '').length), recordsAtName: after.length,
      };
    });
  }
  it('live record split inside a tag', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: '"v=DMARC1; p=none; ru" "a=mailto:x@vendor.test; sp=reject"' });
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    const p = await call(req('/api/domains/1/dmarc', 'PATCH', { policy: 'quarantine' }), env);
    out.splitInsideTag = { status: p.status, record: p.body?.record, previous: p.body?.previous_record, live: recs('_dmarc.acme.com') };
  });
  it('bareTxt/txtContent edges', () => {
    out.bare = {
      single: bareTxt('"v=DMARC1; p=none"'), unquoted: bareTxt('v=DMARC1; p=none'), spaced: bareTxt('"a"   "b"'), escaped: bareTxt('"a\\"b" "c"'),
      oddQuote: bareTxt('"v=DMARC1; p=none'), inner: bareTxt('v=DMARC1; x="y"'),
      tc255: txtContent('x'.repeat(255)) === 'x'.repeat(255), tc256: txtContent('x'.repeat(256)).length,
      problem1024: dmarcRecordProblem(recordOfLength(1024)), problem1025: dmarcRecordProblem(recordOfLength(1025)),
    };
  });
});

describe('PROBE4 spfApplyProblem', () => {
  it('cases', () => {
    const cases = [
      'v=spf1 -all', 'v=spf1 ~all', 'v=spf1 ?all', 'v=spf1 +all', 'v=spf1 all', 'v=spf1 include:_spf.google.com ~all', 'v=spf1 include:mallory.test',
      'v=spf1 a mx -all', 'v=spf1 a:mail.x.com/24 mx:x.com//64 -all', 'v=spf1 ptr -all', 'v=spf1 ptr:x.com -all', 'v=spf1 exists:%{i}._spf.%{d} -all',
      'v=spf1 exists:%{ir}.%{l1r+-}._spf.%{d} -all', 'v=spf1 ip6:2001:db8::/32 -all', 'v=spf1 ip6:::1 -all', 'v=spf1 ip6:zz -all', 'v=spf1 ip4:999.1.1.1 -all', 'v=spf1 ip4:1.2.3.4/33 -all',
      'v=spf1 ip4: -all', 'v=spf1 include: -all', 'v=spf1 -all exp=explain.%{d}', 'v=spf1 exp=a exp=b -all', 'v=spf1 redirect=_spf.x.com', 'v=spf1 redirect=a redirect=b',
      'v=spf1 redirect=_spf.x.com -all', 'v=spf1 -all include:x.com', 'v=spf1 -all foo=bar', 'V=SPF1 -ALL', 'v=spf1 INCLUDE:X.COM -ALL', 'v=spf1 -all ', 'v=spf1  include:x.com   -all',
      ' v=spf1 -all', 'v=spf1', 'v=spf10 -all', 'v=spf1 -all;', 'v=spf1 ~all -all', 'v=spf1 a:%{d} -all', 'v=spf1 unknown:x -all', 'v=spf1 -all\t', 'v=spf1 include:x.com ?all',
    ];
    out.spf = Object.fromEntries(cases.map((c) => [JSON.stringify(c), spfApplyProblem(c)]));
  });
});

describe('PROBE4 zoneReachable', () => {
  for (const d of ['acme.com', 'mail.acme.com', 'deep.sub.acme.com', 'elsewhere.org']) {
    it(`dns-check ${d}`, async () => {
      const env = makeEnv([{ id: 1, domain: d }]);
      const before = cf.calls.length;
      const r = await call(req('/api/domains/1/dns-check', 'GET'), env);
      const calls = cf.calls.slice(before).map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);
      out[`zr:${d}`] = { status: r.status, cf_managed: r.body?.cf_managed, cfApiCalls: calls.length, calls };
    });
  }
  it('dns-check without Cloudflare', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    (env as any).CLOUDFLARE_API_TOKEN = undefined;
    const before = cf.calls.length;
    const r = await call(req('/api/domains/1/dns-check', 'GET'), env);
    out['zr:noCf'] = { status: r.status, cf_managed: r.body?.cf_managed, cfApiCalls: cf.calls.length - before };
  });
  it('zz dump', () => { console.log('PROBE4 ' + JSON.stringify(out, null, 1)); });
});
