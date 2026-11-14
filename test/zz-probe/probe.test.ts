import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

const role = { value: 'owner' as string };
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockImplementation(async () => ({ userId: 'u', workspaceId: 'ws_default', role: role.value, kind: 'instance', user: null })),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: 'x', manual: true }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';
import { dmarcRecordProblem, withPolicy } from '../../src/dmarc/dns-record';
import { assertDnsWriteAllowed } from '../../src/dns/write-policy';
import { proveSender, readAuthHeaders } from '../../src/email/sender-proof';
import { envelopeIsPlain } from '../../src/dmarc/reporter-auth';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => { out[k] = v; };

describe('PROBE units', () => {
  it('dmarcRecordProblem', () => {
    const cases = [
      'v=DMARC1; p=none', 'v=DMARC1;p=none;', 'V=DMARC1; p=none', 'v=dmarc1; p=none', 'v = DMARC1 ; p = none', ' v=DMARC1; p=none ',
      'v=DMARC1; P=REJECT', 'v=DMARC1', 'v=DMARC1; p=none; p=reject', 'v=DMARC1; p=none; rua=mailto:a@b.com!10m,mailto:c@d.com',
      'v=DMARC1; p=none; rua=mailto:a@b.com!10x', 'v=DMARC1; p=none; rua=https://x.com/r', 'v=DMARC1; p=none; ruf=mailto:a@b.com',
      'v=DMARC1; p=none; np=reject; psd=n; t=y', 'v=DMARC1; p=none; foo=bar', 'v=DMARC1; p=none; foo=bar baz', 'v=DMARC1; p=none; x=é',
      'v=DMARC1; p=none; x=a​b', 'v=DMARC1; p=none; x=a b', 'v=DMARC1; p=none; x=a\u0085b', 'v=DMARC1; p=none; rua=mailto:a@b.com; x=;',
      'v=DMARC1; p=none;; sp=reject', 'v=DMARC1; p=none; pct=0', 'v=DMARC1; p=none; pct=101', 'v=DMARC1; p=none; fo=1:d:s', 'v=DMARC1; p=none; sp=none',
      'v=DMARC1; p=reject; rua=mailto:a%40x@b.com', 'v=DMARC1; p=none; rua=mailto:a@b.com,', 'v=DMARC1; p=none; rua=mailto:a@b.com;rua=mailto:c@d.com',
      'v=DMARC1; p=none; ' + 'x'.repeat(300) + '=1', 'v=DMARC1; p=none; rua=mailto:' + 'a'.repeat(900) + '@b.com',
    ];
    log('problem', Object.fromEntries(cases.map((c) => [c.length > 80 ? c.slice(0, 40) + `…(${c.length})` : c, dmarcRecordProblem(c)])));
  });

  it('withPolicy', () => {
    const cases: [string | null, string, string | null][] = [
      ['v=DMARC1', 'reject', 'rua@r.x.com'],
      ['v=DMARC1; rua=mailto:a@b.com; p=none', 'reject', null],
      ['v=DMARC1;  P=NONE ;sp=none; pct=0', 'reject', null],
      ['V=DMARC1; p=none', 'reject', null],
      ['v=DMARC1; p=none; rua=mailto:RUA@R.X.COM!10m', 'quarantine', 'rua@r.x.com'],
      ['v=DMARC1; p=none; p=reject', 'quarantine', null],
      ['"v=DMARC1; p=none; rua=mailto:aaaaaaaa@b.com" "mailto:c@d.com"', 'reject', null],
      ['v=DMARC1; p=none; rua=mailto:a@b.com;;', 'reject', 'rua@r.x.com'],
      ['v=DMARC1; p=none; rua=', 'reject', null],
      ['v=DMARC1; p=none; rua=mailto:a@b.com, mailto:c@d.com', 'reject', 'rua@r.x.com'],
    ];
    log('withPolicy', cases.map(([c, p, r]) => { const w = withPolicy(c, p as any, r); return { in: c, out: w, problem: dmarcRecordProblem(w) }; }));
  });

  it('write policy', () => {
    const t = (w: any) => { try { assertDnsWriteAllowed({ mode: 'selfhost', method: 'POST', type: 'TXT', zoneName: 'acme.com', ...w }); return 'allowed'; } catch (e: any) { return 'refused: ' + e.message; } };
    log('policy', {
      ownDmarc: t({ name: '_dmarc.acme.com', content: 'v=DMARC1; p=none', allowedApexes: ['acme.com'] }),
      ownDmarcUpperV: t({ name: '_dmarc.acme.com', content: 'V=DMARC1; p=none', allowedApexes: ['acme.com'] }),
      ownDmarcSpaced: t({ name: '_dmarc.acme.com', content: 'v = DMARC1; p=none', allowedApexes: ['acme.com'] }),
      ownDmarcQuoted: t({ name: '_dmarc.acme.com', content: '"v=DMARC1; p=none"', allowedApexes: ['acme.com'] }),
      ownDmarcTrailingDot: t({ name: '_dmarc.acme.com.', content: 'v=DMARC1; p=none', allowedApexes: ['ACME.com.'] }),
      otherApex: t({ name: '_dmarc.other.acme.com', content: 'v=DMARC1; p=none', allowedApexes: ['acme.com'] }),
      wildcard: t({ name: '*._dmarc.acme.com', content: 'v=DMARC1; p=none', allowedApexes: ['acme.com'] }),
      nonDmarcContent: t({ name: '_dmarc.acme.com', content: 'hello', allowedApexes: ['acme.com'] }),
      spfAtDmarc: t({ name: '_dmarc.acme.com', content: 'v=spf1 -all', allowedApexes: ['acme.com'] }),
      noApexesAnyDmarc: t({ name: '_dmarc.evil.acme.com', content: 'anything' }),
      authRecordWithApexes: t({ name: 'acme.com._report._dmarc.reports.acme.com', content: 'v=DMARC1;', allowedApexes: ['acme.com'] }),
      mtaStsWithApexes: t({ name: '_mta-sts.acme.com', content: 'v=STSv1; id=1', allowedApexes: ['acme.com'] }),
      spfApplyRoute: t({ name: 'acme.com', content: 'v=spf1 -all', allowedApexes: ['acme.com'] }),
      spfRouteRecordNameIsDmarc: t({ name: '_dmarc.acme.com', content: 'v=DMARC1; p=none', allowedApexes: ['_dmarc.acme.com'] }),
    });
  });

  it('sender proof', async () => {
    const env = { id: 'mx.cloudflare.net', mode: 'ar' };
    const msg = (hdrs: string[]) => new Response(hdrs.join('\r\n') + '\r\n\r\nbody').body;
    // 1. DKIM replay: attacker's own gmail-signed message, re-sent with envelope MAIL FROM victim@gmail.com
    const replay = await readAuthHeaders(msg([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20230601 header.b=abc; spf=softfail (mx.cloudflare.net: domain of transitioning victim@gmail.com does not designate 203.0.113.9 as permitted sender) smtp.mailfrom=victim@gmail.com; dmarc=pass header.from=gmail.com',
      'DKIM-Signature: v=1; a=rsa-sha256; d=gmail.com; s=20230601; h=from:to:subject; bh=x; b=y',
      'From: Attacker <attacker@gmail.com>', 'To: check@rsm.test', 'Subject: hi',
    ]));
    log('replay', { envelopePlain: envelopeIsPlain('victim@gmail.com'), proof: proveSender(replay, 'gmail.com', env.id, env.mode), headerFrom: replay.from });
    // 2. HELO injection with an extra (bogus) DKIM-Signature the receiver does not report
    const helo = await readAuthHeaders(msg([
      'Authentication-Results: mx.cloudflare.net; dkim=fail header.d=attacker.test; spf=none smtp.helo=x;dkim=pass header.d=victim.test; dmarc=fail header.from=victim.test',
      'DKIM-Signature: v=1; a=rsa-sha256; d=attacker.test; s=s; h=from; bh=x; b=y',
      'DKIM-Signature: garbage',
      'From: v@victim.test',
    ]));
    log('heloInjection', { dkimSignatures: helo.dkimSignatures, proof: proveSender(helo, 'victim.test', env.id, env.mode) });
    // 3. Same without the extra signature
    const helo1 = await readAuthHeaders(msg([
      'Authentication-Results: mx.cloudflare.net; dkim=fail header.d=attacker.test; spf=none smtp.helo=x;dkim=pass header.d=victim.test; dmarc=fail header.from=victim.test',
      'DKIM-Signature: v=1; a=rsa-sha256; d=attacker.test; s=s; h=from; bh=x; b=y',
      'From: v@victim.test',
    ]));
    log('heloInjection1sig', proveSender(helo1, 'victim.test', env.id, env.mode));
    // 4. Sender-added AR above? (sender cannot place above receiver's) / sender AR with our authserv-id below the receiver's
    const below = await readAuthHeaders(msg([
      'Authentication-Results: mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=victim.test; dmarc=fail header.from=victim.test',
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=victim.test; dmarc=pass header.from=victim.test',
      'From: v@victim.test',
    ]));
    log('senderAddedBelow', proveSender(below, 'victim.test', env.id, env.mode));
    // 5. folded receiver header with comment containing dkim=pass
    const folded = await readAuthHeaders(msg([
      'Authentication-Results: mx.cloudflare.net;\r\n\tdkim=none (dkim=pass header.d=victim.test);\r\n spf=fail smtp.mailfrom=victim.test; dmarc=fail header.from=victim.test',
      'From: v@victim.test',
    ]));
    log('foldedComment', proveSender(folded, 'victim.test', env.id, env.mode));
    // 6. Envelope variants
    log('envelope', Object.fromEntries(['a@b.com', '"a b"@b.com', '<a@b.com>', '@relay:a@b.com', 'ü@b.com', '', 'a;dkim=pass@b.com', 'a=b@c.com', "a'b@c.com"].map((e) => [e || '(null)', envelopeIsPlain(e)])));
  });

  afterEach(() => { /* noop */ });
  it('zz dump', () => { console.log('PROBE_UNITS ' + JSON.stringify(out, null, 1)); });
});

// ---------- route probes ----------
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
type Db = ReturnType<typeof createMigratedD1>;
let db: Db;
let cf: FakeCloudflare;
function makeEnv(domains: { id: number; domain: string; ws?: string }[]): Env {
  db = createMigratedD1();
  for (const d of domains) {
    if (d.ws && d.ws !== 'ws_default') {
      try { db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'other')").run(d.ws); } catch (e) { console.log('ws insert', String(e)); }
    }
    db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id, dmarc_policy, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(d.id, d.domain, 'rua@reports.acme.com', null, 'none', d.ws ?? 'ws_default');
  }
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'cf-token' } as Env;
}
const req = (path: string, method: string, body?: unknown) => new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call(r: Request, env: Env) { const res = await handleApi(r, env, ctx); await Promise.all(pending.splice(0)); return { status: res.status, body: await res.json().catch(() => null) as any }; }
const routeOut: Record<string, unknown> = {};
beforeEach(() => { cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } })); pending.length = 0; role.value = 'owner'; });
afterEach(() => vi.unstubAllGlobals());
const recs = (name: string) => (cf.records.get('zone-acme') ?? []).filter((r) => r.name === name).map((r) => r.content);
const pol = (id: number) => (db.sqlite.prepare('SELECT dmarc_policy FROM domains WHERE id = ?').get(id) as any)?.dmarc_policy;

describe('PROBE routes', () => {
  const live: Record<string, string> = {
    split: '"v=DMARC1; p=none; rua=mailto:' + 'a'.repeat(230) + '@b.com" "mailto:c@d.com"',
    upperV: 'V=DMARC1; p=none',
    spacedV: 'v = DMARC1; p=none',
    onlyV: 'v=DMARC1',
    pLast: 'v=DMARC1; rua=mailto:x@vendor.test; p=none',
    weird: 'v=DMARC1;p=none;sp=none;pct=0;adkim=s;aspf=s;np=none;t=y',
  };
  for (const [k, content] of Object.entries(live)) {
    it(`patch live ${k}`, async () => {
      cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content });
      const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
      const r = await call(req('/api/domains/1/dmarc', 'PATCH', { policy: 'reject' }), env);
      routeOut[`patch:${k}`] = { status: r.status, body: r.body, live: recs('_dmarc.acme.com'), stored: pol(1), audits: (db.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='domain.dmarc_mode_change'").get() as any).n };
    });
  }
  it('patch subdomain row in parent zone', async () => {
    const env = makeEnv([{ id: 3, domain: 'mail.acme.com' }]);
    const r = await call(req('/api/domains/3/dmarc', 'PATCH', { policy: 'quarantine' }), env);
    routeOut['patch:subdomain'] = { status: r.status, body: r.body, wrote: cf.calls.filter((c) => c.method !== 'GET').map((c) => ({ m: c.method, zone: c.zoneId, name: c.body?.name })) };
  });
  it('patch other workspace domain', async () => {
    const env = makeEnv([{ id: 4, domain: 'acme.com', ws: 'ws_other' }]);
    const r = await call(req('/api/domains/4/dmarc', 'PATCH', { policy: 'reject' }), env);
    routeOut['patch:otherWorkspace'] = { status: r.status, body: r.body, writes: cf.calls.filter((c) => c.method !== 'GET').length };
  });
  it('patch as member', async () => {
    role.value = 'member';
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    const r = await call(req('/api/domains/1/dmarc', 'PATCH', { policy: 'reject' }), env);
    routeOut['patch:member'] = { status: r.status, body: r.body };
  });
  it('apply-dmarc long record then patch', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    const long = 'v=DMARC1; p=none; rua=' + Array.from({ length: 12 }, (_, i) => `mailto:report-address-${i}@vendor-${i}.example.com`).join(',');
    const a = await call(req('/api/domains/1/apply-dmarc', 'POST', { record: long }), env);
    routeOut['apply:long'] = { len: long.length, status: a.status, body: a.body };
    const unicode = await call(req('/api/domains/1/apply-dmarc', 'POST', { record: 'v=DMARC1; p=none; x=​ ' }), env);
    routeOut['apply:unicode'] = { status: unicode.status, body: unicode.body };
    const arr = await call(req('/api/domains/1/apply-dmarc', 'POST', { record: ['v=DMARC1; p=none'] }), env);
    routeOut['apply:array'] = { status: arr.status, body: arr.body };
  });
  it('clamps', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com' }]);
    for (const q of ['limit=-1', 'limit=1e9', 'page=-5', 'since=abc', 'since=-1', 'until=1e3']) {
      const r = await call(req(`/api/audit-log?${q}`, 'GET'), env);
      routeOut[`audit:${q}`] = { status: r.status, page: r.body?.page, limit: r.body?.limit };
    }
    for (const q of ['days=-1', 'days=1000', 'days=abc']) {
      const r = await call(req(`/api/domains/1/stats?${q}`, 'GET'), env);
      routeOut[`stats:${q}`] = { status: r.status, days: r.body?.days };
    }
  });
  it('zz dump routes', () => { console.log('PROBE_ROUTES ' + JSON.stringify(routeOut, null, 1)); });
});
