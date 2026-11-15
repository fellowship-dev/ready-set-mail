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
    expect((await send(w.env, 'POST', '/api/public/reports', { body: { domain: 'acme.com', pad: 'x'.repeat(3000) } })).status).toBe(400);
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

  it(`limits each client IP to ${PUBLIC_REPORT_LIMITS.perIpPerHour} an hour, counting the IP Cloudflare saw, not X-Forwarded-For`, async () => {
    const w = world();
    const ip = '198.51.100.4';
    const codes: number[] = [];
    for (let i = 0; i < PUBLIC_REPORT_LIMITS.perIpPerHour + 2; i++) {
      // A different domain each time (no de-duplication) and a different forged X-Forwarded-For.
      const res = await create(w.env, `d${i}.acme.com`, { ip, headers: { 'x-forwarded-for': `192.0.2.${i}` } });
      codes.push(res.status);
    }
    expect(codes.slice(0, PUBLIC_REPORT_LIMITS.perIpPerHour).every((c) => c === 201)).toBe(true);
    expect(codes.slice(PUBLIC_REPORT_LIMITS.perIpPerHour)).toEqual([429, 429]);
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
    expect(keys).toEqual(['public-report:198.51.100.7', 'public-report:198.51.100.7']);
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

  it(`refuses to store more than ${PUBLIC_REPORT_LIMITS.maxJsonBytes / 1024} KiB of results`, async () => {
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
    expect(res.status).toBe(502);
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
