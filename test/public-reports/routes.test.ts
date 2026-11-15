// Public dated reports: create, read, delete; validation, limits, de-duplication, the daily cap, the size cap, CORS and immutability.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { COMMON_DKIM_SELECTORS } from '@ready-set-mail/dns-checks';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleApi } from '../../src/api/router';
import { PUBLIC_REPORT_LIMITS } from '../../src/public-reports/routes';
import { runRetention } from '../../src/lifecycle/retention';
import { BASE, ctx, freshIp, makeEnv } from '../auth/helpers';
import { installFakeDns, resetFakeDns, type Rec } from './fake-dns';

vi.mock('../../src/public-reports/resolver', async (importOriginal) => (await import('./fake-dns')).fakeResolverModule(importOriginal));

const SITE = 'https://readysetmail.com';
const txt = (...t: string[]) => ({ txt: t });
const ZONE: Record<string, Rec> = {
  '_dmarc.acme.com/TXT': txt('v=DMARC1; p=none; rua=mailto:r@acme.com'),
  'acme.com/TXT': txt('v=spf1 -all'),
  'acme.com/A': { answers: [{ type: 1, data: '192.0.2.1' }] },
  '_dmarc.other.com/TXT': txt('v=DMARC1; p=reject'),
  'other.com/TXT': txt('v=spf1 -all'),
  'other.com/A': { answers: [{ type: 1, data: '192.0.2.2' }] },
};

let logs: string[] = [];
beforeEach(() => {
  installFakeDns(ZONE);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});
afterEach(() => {
  resetFakeDns();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function world(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { PUBLIC_REPORTS_ENABLED: '1', SITE_ORIGINS: SITE, SITE_URL: SITE, ...extra }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, rows };
}

type Opts = { ip?: string; origin?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> };
function send(env: any, method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? freshIp(), ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? SITE;
  const body = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return handleApi(new Request(`${BASE}${path}`, { method, headers, body }), env, ctx);
}
const create = (env: any, domain: unknown, o: Opts = {}) => send(env, 'POST', '/api/public/reports', { body: { domain, source: 'dmarc' }, ...o });

describe('POST /api/public/reports', () => {
  it('runs the check here, stores it and returns the id, the link and a delete token once', async () => {
    const w = world();
    const res = await create(w.env, 'acme.com');
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`${SITE}/r/${body.id}`);
    expect(body.path).toBe(`/r/${body.id}`);
    expect(body.created).toBe(true);
    expect(body.delete_token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.report).toMatchObject({ v: 1, domain: 'acme.com', source: 'dmarc' });
    expect(body.report.dmarc).toMatchObject({ tool: 'dmarc', state: 'ok', tags: { p: 'none' } });
    expect(body.report.spf).toMatchObject({ tool: 'spf', state: 'ok', verdict: 'strict' });
    expect(body.report.dkim).toMatchObject({ tool: 'dkim', mode: 'scan' });
    expect(res.headers.get('cache-control')).toBe('no-store');

    const [row] = w.rows('SELECT * FROM public_reports');
    expect(row).toMatchObject({ id: body.id, domain: 'acme.com', schema_version: 1, source: 'dmarc' });
    expect(row.delete_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.delete_token);
    expect(JSON.parse(row.result_json)).toEqual(body.report);
  });

  it('is off unless PUBLIC_REPORTS_ENABLED=1 (a plain 404)', async () => {
    for (const v of [undefined, '', '0', 'true']) {
      const w = world({ PUBLIC_REPORTS_ENABLED: v });
      expect((await create(w.env, 'acme.com')).status).toBe(404);
      expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
    }
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['an IPv4 address', '192.0.2.1'],
    ['a private IPv4 address', '10.0.0.1'],
    ['an IPv6 address', '[::1]'],
    ['localhost', 'localhost'],
    ['a .local name', 'printer.local'],
    ['an .internal name', 'db.internal'],
    ['a .test name', 'acme.test'],
    ['a public suffix', 'co.uk'],
    ['a single label', 'intranet'],
    ['a URL', 'https://acme.com/path'],
    ['an email address', 'me@acme.com'],
    ['too long', `${'a'.repeat(250)}.com`],
  ])('refuses %s with 400 and stores nothing', async (_n, domain) => {
    const w = world();
    const res = await create(w.env, domain);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toEqual(expect.any(String));
    expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
  });

  it('refuses a body that is not small JSON', async () => {
    const w = world();
    expect((await send(w.env, 'POST', '/api/public/reports', { raw: 'domain=acme.com' })).status).toBe(400);
    expect((await send(w.env, 'POST', '/api/public/reports', { body: { domain: 'acme.com', pad: 'x'.repeat(3000) } })).status).toBe(413);
  });

  it('normalises the name as the checker does: case and a leading www. are dropped', async () => {
    const w = world();
    const body = await (await create(w.env, 'WWW.Acme.COM')).json() as any;
    expect(body.report.domain).toBe('acme.com');
  });

  it('stores nothing the visitor sent except the domain', async () => {
    const w = world();
    const res = await send(w.env, 'POST', '/api/public/reports', { body: { domain: 'acme.com', source: 'call me <script>', note: 'hello-from-visitor', report: { v: 9 } } });
    expect(res.status).toBe(201);
    const [row] = w.rows('SELECT * FROM public_reports');
    expect(row.source).toBe('dmarc');
    expect(JSON.stringify(row)).not.toMatch(/hello-from-visitor|<script>|"v":9/);
  });

  it('keeps the source word when it names a checker', async () => {
    const w = world();
    const body = await (await send(w.env, 'POST', '/api/public/reports', { body: { domain: 'acme.com', source: 'spf' } })).json() as any;
    expect(body.report.source).toBe('spf');
  });

  it('returns the same report for the same domain from the same client within a minute, then a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    const w = world();
    const ip = '203.0.113.9';
    const first = await (await create(w.env, 'acme.com', { ip })).json() as any;
    const again = await create(w.env, 'acme.com', { ip });
    expect(again.status).toBe(200);
    const againBody = await again.json() as any;
    expect(againBody).toMatchObject({ id: first.id, created: false });
    expect(againBody.delete_token).toBeUndefined();
    expect((await (await create(w.env, 'acme.com', { ip: '203.0.113.10' })).json() as any).id).not.toBe(first.id);
    expect((await (await create(w.env, 'other.com', { ip })).json() as any).id).not.toBe(first.id);
    vi.setSystemTime(new Date('2026-11-14T12:01:01Z'));
    const later = await (await create(w.env, 'acme.com', { ip })).json() as any;
    expect(later.created).toBe(true);
    expect(later.id).not.toBe(first.id);
    // The dedupe keys older than the window are cleared; they never hold the IP itself.
    expect(w.rows('SELECT id FROM public_reports WHERE dedupe_key IS NOT NULL').map((r) => r.id)).toEqual([later.id]);
    expect(JSON.stringify(w.rows('SELECT * FROM public_reports'))).not.toContain(ip);
  });

  it(`limits each client IP to ${PUBLIC_REPORT_LIMITS.perClientPerHour} an hour, counting the IP Cloudflare saw, not X-Forwarded-For`, async () => {
    const w = world();
    const ip = '198.51.100.4';
    const codes: number[] = [];
    for (let i = 0; i < PUBLIC_REPORT_LIMITS.perClientPerHour + 2; i++) {
      // A different domain each time (no de-duplication) and a different forged X-Forwarded-For.
      const res = await create(w.env, `d${i}.acme.com`, { ip, headers: { 'x-forwarded-for': `192.0.2.${i}` } });
      codes.push(res.status);
    }
    expect(codes.slice(0, PUBLIC_REPORT_LIMITS.perClientPerHour).every((c) => c === 201)).toBe(true);
    expect(codes.slice(PUBLIC_REPORT_LIMITS.perClientPerHour)).toEqual([429, 429]);
    const limited = await create(w.env, 'acme.com', { ip });
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(limited.headers.get('access-control-allow-origin')).toBe(SITE); // the site can read the 429
    expect((await create(w.env, 'acme.com', { ip: '198.51.100.5' })).status).toBe(201);
    expect(JSON.stringify(w.rows('SELECT key FROM auth_rate_limits'))).not.toContain(ip);
  });

  it('honours the per-minute limiter binding when it is bound, keyed by the client IP', async () => {
    const keys: string[] = [];
    let allow = true;
    const w = world({ DNS_PREVIEW_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow }; } } });
    expect((await create(w.env, 'acme.com', { ip: '198.51.100.7' })).status).toBe(201);
    allow = false;
    const res = await create(w.env, 'other.com', { ip: '198.51.100.7' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(keys).toEqual(['public-report:ip4:198.51.100.7', 'public-report:ip4:198.51.100.7']);
  });

  it('stops at the daily cap for the whole instance with a plain "try again later"', async () => {
    const w = world({ PUBLIC_REPORTS_DAILY_CAP: '2' });
    expect((await create(w.env, 'acme.com')).status).toBe(201);
    expect((await create(w.env, 'other.com')).status).toBe(201);
    const capped = await create(w.env, 'acme.com');
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as any).error).toMatch(/try again later/i);
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 2 }]);
  });

  it(`refuses to store more than ${PUBLIC_REPORT_LIMITS.maxReportBytes / 1024} KiB of results`, async () => {
    const big = `v=DKIM1; k=rsa; p=${'A'.repeat(2500)}`;
    installFakeDns({ ...ZONE, ...Object.fromEntries(COMMON_DKIM_SELECTORS.map((s) => [`${s}._domainkey.acme.com/TXT`, txt(big)])) });
    const w = world();
    const res = await create(w.env, 'acme.com');
    expect(res.status).toBe(413);
    expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
  });

  it('stores nothing when DNS did not answer at all', async () => {
    const w = world();
    // Every name answers SERVFAIL from both resolvers.
    installFakeDns(new Proxy({}, { get: () => 'servfail' }) as Record<string, Rec>);
    const res = await create(w.env, 'acme.com');
    expect(res.status).toBe(503);
    expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
  });
});

describe('GET /api/public/reports/:id', () => {
  it('returns the stored report, cacheable and the same every time, even after DNS changes', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    const get = () => send(w.env, 'GET', `/api/public/reports/${made.id}`);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, immutable');
    const first = await res.text();
    expect(JSON.parse(first)).toMatchObject({ id: made.id, domain: 'acme.com', schema_version: 1, source: 'dmarc', report: made.report });
    expect(first).not.toMatch(/delete_token|dedupe/);

    // DNS changes and the domain is checked again (from elsewhere): a new report; the old one is unchanged.
    installFakeDns({ ...ZONE, '_dmarc.acme.com/TXT': txt('v=DMARC1; p=reject; rua=mailto:r@acme.com') });
    const newer = await (await create(w.env, 'acme.com')).json() as any;
    expect(newer.id).not.toBe(made.id);
    expect(newer.report.dmarc.tags.p).toBe('reject');
    expect(await (await get()).text()).toBe(first);
  });

  it('answers unknown, malformed and deleted ids with the same 404', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    await send(w.env, 'DELETE', `/api/public/reports/${made.id}`, { body: { delete_token: made.delete_token } });
    const answers = await Promise.all(
      [made.id, 'A'.repeat(22), 'short', `${made.id}x`, '..%2F..', 'a'.repeat(200)].map(async (id) => {
        const r = await send(w.env, 'GET', `/api/public/reports/${id}`);
        return { status: r.status, body: await r.text(), cache: r.headers.get('cache-control') };
      }),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, body: '{"error":"not found"}', cache: 'no-store' });
  });

  it('is readable even when creating is switched off', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    w.env.PUBLIC_REPORTS_ENABLED = undefined;
    expect((await send(w.env, 'GET', `/api/public/reports/${made.id}`)).status).toBe(200);
  });
});

describe('DELETE /api/public/reports/:id', () => {
  it('removes the report only with its delete token', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    const del = (token: unknown) => send(w.env, 'DELETE', `/api/public/reports/${made.id}`, { body: { delete_token: token } });
    for (const wrong of ['B'.repeat(22), undefined, 42, made.id]) {
      const res = await del(wrong);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('{"error":"not found"}');
    }
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 1 }]);
    const ok = await del(made.delete_token);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 0 }]);
    expect((await send(w.env, 'GET', `/api/public/reports/${made.id}`)).status).toBe(404);
    expect((await del(made.delete_token)).status).toBe(404);
  });
});

describe('CORS for the public reports', () => {
  it('lets exactly SITE_ORIGINS create, read and delete from a browser, with the right preflight methods', async () => {
    const w = world();
    const pre = await send(w.env, 'OPTIONS', '/api/public/reports');
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toBe('Content-Type');
    const item = await send(w.env, 'OPTIONS', `/api/public/reports/${'A'.repeat(22)}`);
    expect(item.headers.get('access-control-allow-methods')).toBe('GET, DELETE, OPTIONS');
    const made = await create(w.env, 'acme.com');
    expect(made.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(made.headers.get('access-control-allow-credentials')).toBeNull();
    expect(made.headers.get('vary')).toContain('Origin');
  });

  it('gives nothing to any other origin: www, a lookalike, http, none, or with SITE_ORIGINS unset', async () => {
    const w = world();
    for (const origin of ['https://www.readysetmail.com', 'https://readysetmail.com.evil.example', 'http://readysetmail.com', 'https://evil.example']) {
      expect((await send(w.env, 'OPTIONS', '/api/public/reports', { origin })).status, origin).toBe(403);
      expect((await create(w.env, 'acme.com', { origin })).headers.get('access-control-allow-origin'), origin).toBeNull();
    }
    expect((await create(w.env, 'acme.com', { origin: null })).headers.get('access-control-allow-origin')).toBeNull();
    const unset = world({ SITE_ORIGINS: undefined });
    expect((await create(unset.env, 'acme.com')).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('logging', () => {
  it('never logs a report id or a delete token', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    await send(w.env, 'GET', `/api/public/reports/${made.id}`);
    await send(w.env, 'DELETE', `/api/public/reports/${made.id}`, { body: { delete_token: made.delete_token } });
    const all = logs.join('\n');
    expect(all).not.toContain(made.id);
    expect(all).not.toContain(made.delete_token);
  });
});

describe('retention', () => {
  it('keeps every report, and clears the de-duplication keys once their minute has passed', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports WHERE dedupe_key IS NOT NULL')).toEqual([{ n: 1 }]);
    await runRetention(w.env, { now: () => Date.now() + 365 * 86_400_000 });
    expect(w.rows('SELECT id, dedupe_key FROM public_reports')).toEqual([{ id: made.id, dedupe_key: null }]);
  });
});

// ── Review round 1: limits per network, budgets, completeness, rotating keys, logging, body size, hostile DNS text ──

const usage = (w: ReturnType<typeof world>) => w.rows('SELECT * FROM public_report_usage')[0] ?? null;
const rateRows = (w: ReturnType<typeof world>) => w.rows('SELECT key FROM auth_rate_limits').length;

describe('GET /api/public/reports/status', () => {
  it('says whether this instance makes reports, so the site claims "saved" only when it does', async () => {
    for (const [v, enabled] of [['1', true], [undefined, false], ['0', false]] as const) {
      const res = await send(world({ PUBLIC_REPORTS_ENABLED: v }).env, 'GET', '/api/public/reports/status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled });
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    }
  });
});

describe('limits per client and per network', () => {
  it(`counts an IPv6 /64 as one client: 40 addresses in one /64 make ${PUBLIC_REPORT_LIMITS.perClientPerHour} reports, then 429`, async () => {
    const w = world();
    const codes: number[] = [];
    for (let i = 1; i <= 40; i++) codes.push((await create(w.env, `d${i}.acme.com`, { ip: `2001:db8:1:2::${i.toString(16)}` })).status);
    expect(codes.slice(0, PUBLIC_REPORT_LIMITS.perClientPerHour).every((c) => c === 201)).toBe(true);
    expect(codes.slice(PUBLIC_REPORT_LIMITS.perClientPerHour)).toEqual(Array(40 - PUBLIC_REPORT_LIMITS.perClientPerHour).fill(429));
    // The long and the short spelling of an address in the same /64 are the same client; the next /64 is another one.
    expect((await create(w.env, 'x.acme.com', { ip: '2001:0db8:0001:0002:ffff:0000:0000:0001' })).status).toBe(429);
    expect((await create(w.env, 'x.acme.com', { ip: '2001:db8:1:3::1' })).status).toBe(201);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: PUBLIC_REPORT_LIMITS.perClientPerHour + 1 }]);
  });

  it(`limits each IPv6 /48 and each IPv4 /24 to ${PUBLIC_REPORT_LIMITS.perNetworkPerHour} an hour and ${PUBLIC_REPORT_LIMITS.perNetworkPerDay} a day`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T01:00:00Z'));
    const w = world();
    const hour = PUBLIC_REPORT_LIMITS.perNetworkPerHour;
    // One report from each of `hour` different /64s inside 2001:db8:5::/48.
    let n = 0;
    const v6 = async () => (await create(w.env, `v${++n}.acme.com`, { ip: `2001:db8:5:${n.toString(16)}::1` })).status;
    const first: number[] = [];
    for (let i = 0; i < hour; i++) first.push(await v6());
    expect(first.every((c) => c === 201)).toBe(true);
    const over = await create(w.env, 'over.acme.com', { ip: '2001:db8:5:ffff::1' });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('3600');
    expect((await create(w.env, 'elsewhere.acme.com', { ip: '2001:db8:6::1' })).status).toBe(201); // another /48
    // The next hour the /48 may make another `hour`, which reaches the day's limit.
    vi.setSystemTime(new Date('2026-11-14T02:30:00Z'));
    const second: number[] = [];
    for (let i = 0; i < PUBLIC_REPORT_LIMITS.perNetworkPerDay - hour - 1; i++) second.push(await v6());
    expect(second.every((c) => c === 201)).toBe(true);
    const dayOver = await create(w.env, 'day.acme.com', { ip: '2001:db8:5:fffe::1' });
    expect(dayOver.status).toBe(429);
    expect(dayOver.headers.get('retry-after')).toBe('86400');

    // IPv4: four addresses in one /24 share its hourly limit.
    const v4: number[] = [];
    for (let i = 0; i < hour; i++) v4.push((await create(w.env, `w${i}.acme.com`, { ip: `192.0.2.${1 + (i % 4)}` })).status);
    expect(v4.every((c) => c === 201)).toBe(true);
    expect((await create(w.env, 'w-over.acme.com', { ip: '192.0.2.200' })).status).toBe(429);
    expect((await create(w.env, 'w-other.acme.com', { ip: '192.0.3.1' })).status).toBe(201);
  }, 60_000);

  it('refuses a request without a usable client address instead of pooling it, and writes nothing', async () => {
    const w = world();
    for (const ip of ['', 'unknown', '999.1.1.1', '2001:db8::1::2', 'fe80::1%eth0']) {
      const res = await create(w.env, 'acme.com', { ip });
      expect(res.status, ip).toBe(400);
    }
    expect(rateRows(w)).toBe(0);
    expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
  });

  it('checks the daily cap before any write: past the cap, new addresses add no counter rows', async () => {
    const w = world({ PUBLIC_REPORTS_DAILY_CAP: '1' });
    expect((await create(w.env, 'acme.com')).status).toBe(201);
    const before = rateRows(w);
    for (let i = 0; i < 5; i++) expect((await create(w.env, `d${i}.acme.com`, { ip: `198.51.100.${50 + i}` })).status).toBe(429);
    expect(rateRows(w)).toBe(before);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 1 }]);
  });

  it('keys the counters and the dedupe hash with a key that changes every UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = world();
    const ip = '203.0.113.77';
    vi.setSystemTime(new Date('2026-11-14T23:59:00Z'));
    const a = await (await create(w.env, 'acme.com', { ip })).json() as any;
    const dayOne = w.rows("SELECT key FROM auth_rate_limits").map((r) => r.key);
    const dedupeOne = w.rows('SELECT dedupe_key FROM public_reports')[0].dedupe_key;
    vi.setSystemTime(new Date('2026-11-15T00:01:30Z'));
    const b = await (await create(w.env, 'acme.com', { ip })).json() as any;
    expect(b.id).not.toBe(a.id);
    const dayTwo = w.rows("SELECT key FROM auth_rate_limits").map((r) => r.key).filter((k) => !dayOne.includes(k));
    expect(dayTwo).toHaveLength(dayOne.length); // every key is new
    expect(w.rows('SELECT dedupe_key FROM public_reports WHERE id = ?', b.id)[0].dedupe_key).not.toBe(dedupeOne);
    expect(JSON.stringify(w.rows('SELECT * FROM auth_rate_limits'))).not.toContain(ip);
  });
});

describe('storage budgets', () => {
  it('counts bytes, refuses past the total with a plain 503 while existing reports still open, and gives bytes back on delete', async () => {
    const w = world();
    const first = await (await create(w.env, 'acme.com')).json() as any;
    const bytes = new TextEncoder().encode(JSON.stringify(first.report)).length;
    expect(usage(w)).toMatchObject({ total_reports: 1, total_bytes: bytes, day_reports: 1, day_bytes: bytes });
    expect(w.rows('SELECT result_bytes FROM public_reports')).toEqual([{ result_bytes: bytes }]);
    w.env.PUBLIC_REPORTS_TOTAL_BYTES = String(Math.floor(bytes * 1.5));
    const full = await create(w.env, 'other.com');
    expect(full.status).toBe(503);
    expect(((await full.json()) as any).error).toBe('We cannot save more reports at the moment. Try again later.');
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 1 }]);
    expect((await send(w.env, 'GET', `/api/public/reports/${first.id}`)).status).toBe(200);
    expect((await send(w.env, 'DELETE', `/api/public/reports/${first.id}`, { body: { delete_token: first.delete_token } })).status).toBe(204);
    expect(usage(w)).toMatchObject({ total_reports: 0, total_bytes: 0 });
    expect((await create(w.env, 'other.com')).status).toBe(201);
  });

  it('stops at the daily byte budget with a 429 and at the per-report cap with a 413, both configurable', async () => {
    const w = world();
    const first = await (await create(w.env, 'acme.com')).json() as any;
    const bytes = new TextEncoder().encode(JSON.stringify(first.report)).length;
    w.env.PUBLIC_REPORTS_DAILY_BYTES = String(Math.floor(bytes * 1.5));
    const daily = await create(w.env, 'other.com');
    expect(daily.status).toBe(429);
    expect(((await daily.json()) as any).error).toMatch(/today/);
    const small = world({ PUBLIC_REPORTS_MAX_REPORT_BYTES: '1000' });
    expect((await create(small.env, 'acme.com')).status).toBe(413);
    expect(usage(small)).toBeNull();
  });

  it('says so at 80% of the total: one log line when a report crosses it, and the instance preflight', async () => {
    const { instancePreflight } = await import('../../src/setup/preflight');
    const w = world();
    const first = await (await create(w.env, 'acme.com')).json() as any;
    const bytes = new TextEncoder().encode(JSON.stringify(first.report)).length;
    expect(logs.join('\n')).not.toContain('80%');
    expect((await instancePreflight(w.env, SITE)).public_reports).toMatchObject({ enabled: true, stored_reports: 1, stored_bytes: bytes, total_budget_bytes: 1024 ** 3, near_limit: false });
    w.env.PUBLIC_REPORTS_TOTAL_BYTES = String(Math.floor((bytes * 2) / 0.85));
    expect((await create(w.env, 'other.com')).status).toBe(201);
    expect(logs.filter((l) => l.includes('80% of PUBLIC_REPORTS_TOTAL_BYTES'))).toHaveLength(1);
    const pre = await instancePreflight(w.env, SITE);
    expect(pre.public_reports).toMatchObject({ stored_reports: 2, near_limit: true });
    expect(pre.items.find((i) => i.id === 'public_reports')).toMatchObject({ severity: 'note', setting: 'PUBLIC_REPORTS_TOTAL_BYTES' });
  });

  it('keeps the daily cap exact under a parallel burst (one atomic counter, not a COUNT)', async () => {
    const w = world({ PUBLIC_REPORTS_DAILY_CAP: '3' });
    const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => create(w.env, `p${i}.acme.com`, { ip: `198.51.100.${100 + i}` }).then((r) => r.status)));
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(9);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports')).toEqual([{ n: 3 }]);
    expect(usage(w)).toMatchObject({ day_reports: 3, total_reports: 3 });
  });
});

describe('only complete reports are stored', () => {
  it.each([
    ['one DKIM selector fails', { [`${COMMON_DKIM_SELECTORS[0]}._domainkey.acme.com/TXT`]: 'servfail' as Rec }],
    ['the DMARC lookup fails', { '_dmarc.acme.com/TXT': 'servfail' as Rec }],
    ['an SPF include fails', { 'acme.com/TXT': txt('v=spf1 include:mail.acme.com -all'), 'mail.acme.com/TXT': 'servfail' as Rec }],
    ['the existence lookup fails', { 'acme.com/A': 'servfail' as Rec }],
  ])('answers 503 and stores nothing when %s', async (_n, broken) => {
    installFakeDns({ ...ZONE, ...broken });
    const w = world();
    const res = await create(w.env, 'acme.com');
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toMatch(/no report was saved/);
    expect(w.rows('SELECT * FROM public_reports')).toEqual([]);
    expect(usage(w)).toBeNull();
  });
});

describe('storage errors', () => {
  it('logs a fixed sentence, never the bound values, and answers 503', async () => {
    const w = world();
    const real = w.env.DB;
    w.env.DB = new Proxy(real, {
      get(t, k) {
        if (k === 'prepare') {
          return (q: string) => {
            const stmt = t.prepare(q);
            if (!/insert into "public_reports"/i.test(q)) return stmt;
            const failing = (args: unknown[]) => {
              const fail = async () => { throw new Error(`D1_ERROR: Failed query: ${q} params: ${args.join(',')}`); };
              return { bind: (...more: unknown[]) => failing(more), run: fail, all: fail, raw: fail, first: fail };
            };
            return failing([]);
          };
        }
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const res = await create(w.env, 'secret-domain.acme.com');
    expect(res.status).toBe(503);
    const all = logs.join('\n');
    expect(all).toContain('[public-reports] storage error while making a report');
    expect(all).not.toMatch(/secret-domain|params|[0-9a-f]{32}/);
    expect(usage(w)).toMatchObject({ total_reports: 0, total_bytes: 0 }); // the reservation was given back
  });
});

describe('request bodies', () => {
  const stream = (pulls: { n: number }, endless = true) => new ReadableStream<Uint8Array>({
    pull(c) {
      pulls.n++;
      if (!endless) throw new Error('must not be read');
      c.enqueue(new TextEncoder().encode(' '.repeat(1024)));
    },
  }, { highWaterMark: 0 }); // nothing is pulled until the body is read
  const post = (env: any, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    handleApi(new Request(`${BASE}/api/public/reports`, { method: 'POST', body, duplex: 'half', headers: { 'cf-connecting-ip': freshIp(), origin: SITE, 'content-type': 'application/json', ...headers } } as RequestInit), env, ctx);

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const w = world();
    const pulls = { n: 0 };
    const res = await post(w.env, stream(pulls, false), { 'content-length': String(10 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(pulls.n).toBe(0);
  });

  it('stops reading an endless body at the cap', async () => {
    const w = world();
    const pulls = { n: 0 };
    const res = await post(w.env, stream(pulls));
    expect(res.status).toBe(413);
    expect(pulls.n).toBeLessThan(10);
  }, 5_000);
});

describe('hostile DNS text', () => {
  it('stores no bidi or control character and quotes DNS text in sentences at most 64 characters', async () => {
    const evil = `\u202Eevil\u0007${'x'.repeat(200)}`;
    installFakeDns({ ...ZONE, '_dmarc.acme.com/TXT': txt(`v=DMARC1; p=${evil}`) });
    const w = world();
    const res = await create(w.env, 'acme.com');
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    const stored = w.rows('SELECT result_json FROM public_reports')[0].result_json as string;
    for (const text of [stored, JSON.stringify(body.report)]) expect(text).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/);
    expect(body.report.dmarc.record).toContain('[U+202E]evil[U+0007]'); // the record box shows what is there, made visible
    const sentence = body.report.dmarc.findings.find((f: any) => f.code === 'dmarc-invalid').message as string;
    const quoted = /"(.*)"/.exec(sentence)![1]!;
    expect(Array.from(quoted).length).toBeLessThanOrEqual(64);
    expect(quoted.endsWith('…')).toBe(true);
    expect(quoted.startsWith('evil')).toBe(true);
  });
});

describe('retention keeps the dedupe keys short-lived', () => {
  it('clears them first, even when the run has a single statement to spend', async () => {
    const w = world();
    await create(w.env, 'acme.com');
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports WHERE dedupe_key IS NOT NULL')).toEqual([{ n: 1 }]);
    const report = await runRetention(w.env, { now: () => Date.now() + 120_000, limits: { statements: 1 } });
    expect(report.public_report_dedupe_keys).toBe(1);
    expect(w.rows('SELECT COUNT(*) AS n FROM public_reports WHERE dedupe_key IS NOT NULL')).toEqual([{ n: 0 }]);
  });

  it('sweeps old rate-limit counters and recounts the stored bytes', async () => {
    const w = world();
    const made = await (await create(w.env, 'acme.com')).json() as any;
    expect(rateRows(w)).toBeGreaterThan(0);
    w.db.sqlite.prepare('UPDATE public_report_usage SET total_bytes = 1, total_reports = 9').run();
    await runRetention(w.env, { now: () => Date.now() + 3 * 86_400_000 });
    expect(rateRows(w)).toBe(0);
    expect(usage(w)).toMatchObject({ total_reports: 1, total_bytes: new TextEncoder().encode(JSON.stringify(made.report)).length });
  });
});
