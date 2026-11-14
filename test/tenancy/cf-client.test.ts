import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import {
  CfApiError, CfAuthError, CfClient, CfIncompleteListError, CfNetworkError, CfRecordNotAllowedError, CfNotConfiguredError, CfNotFoundError, CfZoneNotFoundError,
  cfApiBase, cfErrorText, zoneCandidates,
} from '../../src/tenancy/cf-client';
import { FakeCloudflare } from '../helpers/cf-fake';

const TOKEN = 'super-secret-token-value';
afterEach(() => vi.restoreAllMocks());

function clientFor(fake: FakeCloudflare) {
  return new CfClient(TOKEN, { fetch: fake.fetch as unknown as typeof fetch });
}

describe('zoneCandidates', () => {
  it('lists candidates longest first, never below two labels', () => {
    expect(zoneCandidates('acme.com')).toEqual(['acme.com']);
    expect(zoneCandidates('a.b.acme.com')).toEqual(['a.b.acme.com', 'b.acme.com', 'acme.com']);
    expect(zoneCandidates('Mail.Acme.CO.UK.')).toEqual(['mail.acme.co.uk', 'acme.co.uk', 'co.uk']);
  });
});

describe('CfClient.zoneFor', () => {
  it('finds the zone of a subdomain by its registrable name and returns the Cloudflare account', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1', cfAccountId: 'acct-1' } });
    expect(await clientFor(fake).zoneFor('a.b.acme.com')).toEqual({ id: 'z1', name: 'acme.com', cfAccountId: 'acct-1' });
  });

  it('skips names Cloudflare has no zone for (co.uk) and finds the real one', async () => {
    const fake = new FakeCloudflare({ 'acme.co.uk': { id: 'z-uk' } });
    expect((await clientFor(fake).zoneFor('www.acme.co.uk')).id).toBe('z-uk');
  });

  it('caches per client: repeated and concurrent lookups hit the API once', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    const cf = clientFor(fake);
    await Promise.all([cf.zoneFor('acme.com'), cf.zoneFor('acme.com'), cf.zoneFor('www.acme.com')]);
    await cf.zoneFor('acme.com');
    expect(fake.calls.filter(c => c.url.includes('name=acme.com'))).toHaveLength(1);
  });

  it('does not share the cache between clients (no module-level state)', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    await clientFor(fake).zoneFor('acme.com');
    await clientFor(fake).zoneFor('acme.com');
    expect(fake.calls.filter(c => c.url.includes('name=acme.com'))).toHaveLength(2);
  });

  it('uses a seeded zone without any API call', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    cf.seedZone({ id: 'seeded', name: 'acme.com' });
    expect((await cf.zoneFor('acme.com')).id).toBe('seeded');
    expect(fake.calls).toHaveLength(0);
    // a subdomain is checked for a zone of its own first (one lookup), then falls back to the seed
    expect((await cf.zoneFor('mail.acme.com')).id).toBe('seeded');
    expect(fake.calls).toHaveLength(1);
  });

  it('throws CfZoneNotFoundError when no candidate exists, and retries after a failed lookup', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    await expect(cf.zoneFor('nope.net')).rejects.toBeInstanceOf(CfZoneNotFoundError);

    fake.failWith = { status: 500, message: 'boom' };
    await expect(cf.zoneFor('flaky.net')).rejects.toBeInstanceOf(CfApiError);
    fake.failWith = undefined;
    fake.zones['flaky.net'] = { id: 'z-flaky' };
    expect((await cf.zoneFor('flaky.net')).id).toBe('z-flaky');
  });
});

describe('CfClient.zoneFor with nested zones', () => {
  const nested = () => new FakeCloudflare({ 'example.com': { id: 'z-parent' }, 'sub.example.com': { id: 'z-child' } });

  it('the most specific zone wins over its parent', async () => {
    const cf = clientFor(nested());
    expect((await cf.zoneFor('_dmarc.sub.example.com')).id).toBe('z-child');
    expect((await cf.zoneFor('sub.example.com')).id).toBe('z-child');
    expect((await cf.zoneFor('other.example.com')).id).toBe('z-parent');
    expect((await cf.zoneFor('example.com')).id).toBe('z-parent');
  });

  it('a pre-loaded parent zone does not shadow a child zone', async () => {
    const fake = nested();
    const cf = clientFor(fake);
    cf.seedZone({ id: 'z-parent', name: 'example.com' });
    expect((await cf.zoneFor('_dmarc.sub.example.com')).id).toBe('z-child');
    // ...but still answers, without a lookup, for names with no longer candidate zone
    const before = fake.calls.length;
    expect((await cf.zoneFor('example.com')).id).toBe('z-parent');
    expect(fake.calls.length).toBe(before);
  });

  it('a pre-loaded parent answers for a subdomain that is not its own zone', async () => {
    const cf = clientFor(new FakeCloudflare({ 'example.com': { id: 'z-parent' } }));
    cf.seedZone({ id: 'z-parent', name: 'example.com' });
    expect((await cf.zoneFor('mail.example.com')).id).toBe('z-parent');
  });

  it('resolves a deep subdomain to the nearest enclosing zone', async () => {
    const fake = new FakeCloudflare({ 'example.com': { id: 'z-parent' }, 'b.example.com': { id: 'z-b' } });
    expect((await clientFor(fake).zoneFor('x.y.z.b.example.com')).id).toBe('z-b');
    expect((await clientFor(fake).zoneFor('x.y.z.other.example.com')).id).toBe('z-parent');
  });
});

describe('CfClient typed errors', () => {
  it('maps 401/403 to CfAuthError, 404 to CfNotFoundError, other failures to CfApiError', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    fake.failWith = { status: 403, message: 'no permission' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfAuthError);
    fake.failWith = { status: 401, message: 'bad token' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfAuthError);
    fake.failWith = { status: 404, message: 'gone' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfNotFoundError);
    fake.failWith = { status: 400, message: 'bad request' };
    const e = await cf.request('GET', '/zones').catch(x => x);
    expect(e).toBeInstanceOf(CfApiError);
    expect(e.status).toBe(400);
    expect(e.details).toEqual([{ message: 'bad request' }]);
    expect(cfErrorText(e)).toBe('bad request');
  });

  it('treats success:false on HTTP 200 as an error', async () => {
    const cf = new CfClient(TOKEN, { fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 200 })) as typeof fetch });
    await expect(cf.request('GET', '/x')).rejects.toBeInstanceOf(CfApiError);
  });

  it('maps a thrown fetch to CfNetworkError without echoing the cause', async () => {
    const cf = new CfClient(TOKEN, { fetch: (async () => { throw new Error(`socket hang up for ${TOKEN}`); }) as typeof fetch });
    const e = await cf.request('GET', '/zones').catch(x => x);
    expect(e).toBeInstanceOf(CfNetworkError);
    expect(String(e.message)).not.toContain(TOKEN);
  });

  it('delete of a missing record is not an error', async () => {
    const fake = new FakeCloudflare({});
    await expect(clientFor(fake).deleteDnsRecord('z', 'missing', { type: 'TXT', name: '_dmarc.acme.com' })).resolves.toBe(false);
  });

  it('refuses to be built without a token', () => {
    expect(() => new CfClient('')).toThrow(CfNotConfiguredError);
  });
});

describe('CfClient never leaks the token', () => {
  it('sends it only as the Authorization header', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    await clientFor(fake).zoneFor('acme.com');
    expect(fake.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(fake.calls[0].url).not.toContain(TOKEN);
  });

  it('is absent from errors, JSON, inspect output and console logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map(s => s.mockImplementation(() => {}));
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    fake.failWith = { status: 403, message: 'Authentication error' };
    const e = await cf.zoneFor('acme.com').catch(x => x);

    const everything = [
      JSON.stringify(cf), inspect(cf, { depth: 5 }), String(cf), `${cf}`,
      e.message, e.stack, inspect(e, { depth: 5 }), JSON.stringify({ ...e, message: e.message }),
      ...logs.flatMap(l => l.mock.calls.map(c => c.map(String).join(' '))),
    ].join('\n');
    expect(everything).not.toContain(TOKEN);
  });
});

describe('TenantContext never leaks the env secrets', () => {
  it('is redacted in JSON, inspect and string output', async () => {
    const { makeTenant } = await import('../helpers/tenant');
    const t = makeTenant({ env: { CLOUDFLARE_API_TOKEN: TOKEN, API_KEY: 'api-key-secret' } as any, cfToken: TOKEN });
    const out = [JSON.stringify(t), inspect(t, { depth: 6 }), JSON.stringify({ wrapped: t }), `${inspect({ nested: [t] }, { depth: 6 })}`].join('\n');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('api-key-secret');
    expect(out).toContain('ws_default');
  });
});

describe('CLOUDFLARE_API_BASE_URL guard', () => {
  const REAL = 'https://api.cloudflare.com/client/v4';
  it('honours only http://127.0.0.1:<port> and http://localhost:<port>', () => {
    expect(cfApiBase('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788/client/v4');
    expect(cfApiBase('http://localhost:9999/')).toBe('http://localhost:9999/client/v4');
  });
  it('ignores everything else and uses the real API', () => {
    for (const v of [undefined, '', 'not a url', 'https://127.0.0.1:8788', 'http://127.0.0.1', 'http://evil.example:80', 'http://127.0.0.1.evil.example:80',
      'http://localhost:80@evil.example', 'http://user:pw@localhost:80', 'http://127.0.0.1:8788/path', 'http://localhost:8788?x=1', 'http://localhost:8788#x',
      'http://[::1]:8788', 'http://0.0.0.0:8788', 'http://localhost.evil.example:8788', 'ftp://localhost:21']) {
      expect(cfApiBase(v), String(v)).toBe(REAL);
    }
  });
  it('a client sends its requests to the honoured base, and to the real API otherwise', async () => {
    const urls: string[] = [];
    const fetchStub = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ success: true, result: [], result_info: { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 } })); }) as unknown as typeof fetch;
    await new CfClient(TOKEN, { fetch: fetchStub, apiBaseUrl: 'http://127.0.0.1:8788' }).listAccounts();
    await new CfClient(TOKEN, { fetch: fetchStub, apiBaseUrl: 'https://evil.example' }).listAccounts();
    expect(urls[0]).toBe('http://127.0.0.1:8788/client/v4/accounts?per_page=50&page=1');
    expect(urls[1]).toBe(`${REAL}/accounts?per_page=50&page=1`);
  });
});

describe('CfClient.listAll / listDnsRecords: every page, or an error', () => {
  const Zid = 'z1';
  const seed = (fake: FakeCloudflare, n: number) => { for (let i = 0; i < n; i++) fake.seed(Zid, { type: 'TXT', name: 'many.acme.com', content: `v=${i}` }); };
  const asked = (fake: FakeCloudflare) => fake.calls.map(c => { const u = new URL(c.url); return `${u.searchParams.get('page')}/${u.searchParams.get('per_page')}`; });

  it('reads 50 per page until total_count is reached', async () => {
    const fake = new FakeCloudflare({});
    seed(fake, 120);
    expect(await clientFor(fake).listDnsRecords(Zid, { type: 'TXT', name: 'many.acme.com' })).toHaveLength(120);
    expect(asked(fake)).toEqual(['1/50', '2/50', '3/50']);
  });

  it('an empty list is one page', async () => {
    const fake = new FakeCloudflare({});
    expect(await clientFor(fake).listDnsRecords(Zid, { type: 'TXT' })).toEqual([]);
    expect(asked(fake)).toEqual(['1/50']);
  });

  it('a page that fails fails the whole read', async () => {
    const fake = new FakeCloudflare({});
    seed(fake, 80);
    const inner = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (i, init) => new URL(String(i)).searchParams.get('page') === '2' ? new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 }) : inner(i, init));
    await expect(clientFor(fake).listDnsRecords(Zid, {})).rejects.toBeInstanceOf(CfApiError);
  });

  const tamper = (fake: FakeCloudflare, f: (b: any, page: number) => void) => {
    const inner = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (i, init) => {
      const r = await inner(i, init);
      const b = await r.json() as any;
      f(b, Number(new URL(String(i)).searchParams.get('page')));
      return new Response(JSON.stringify(b), { status: 200 });
    });
  };
  it.each<[string, (b: any, page: number) => void, RegExp]>([
    ['no result_info', b => { delete b.result_info; }, /no total count/],
    ['a different page than asked', (b, p) => { if (p === 2) b.result_info.page = 1; }, /asked for page 2/],
    ['a short page', (b, p) => { if (p === 2) b.result = b.result.slice(1); }, /expected/],
    ['a total that changes', (b, p) => { if (p === 2) b.result_info.total_count += 1; }, /total changed/],
    ['a page size above the one asked', b => { b.result_info.per_page = 500; }, /implausible page size/],
    ['a result that is not a list', b => { b.result = {}; }, /no list/],
  ])('refuses %s', async (_t, f, why) => {
    const fake = new FakeCloudflare({});
    seed(fake, 80);
    tamper(fake, f);
    const e = await clientFor(fake).listDnsRecords(Zid, {}).catch(x => x);
    expect(e).toBeInstanceOf(CfIncompleteListError);
    expect(e.message).toMatch(why);
  });

  it('refuses a list over the caps (1000 entries / 20 pages) without walking it', async () => {
    const fake = new FakeCloudflare({});
    seed(fake, 1001);
    await expect(clientFor(fake).listDnsRecords(Zid, {})).rejects.toBeInstanceOf(CfIncompleteListError);
    expect(fake.calls).toHaveLength(1);
  });

  it('per_page given keeps the older single-page read', async () => {
    const fake = new FakeCloudflare({});
    seed(fake, 80);
    expect(await clientFor(fake).listDnsRecords(Zid, { per_page: 5 })).toHaveLength(5);
  });
});

describe('CfClient.deleteDnsRecord checks the record stored under the id', () => {
  const Zid = 'a'.repeat(32);
  const setup = () => { const fake = new FakeCloudflare({}); const rec = fake.seed(Zid, { type: 'TXT', name: 'x._report._dmarc.reports.acme.com', content: '"v=DMARC1;"' }); return { fake, rec, cf: clientFor(fake) }; };
  const methods = (fake: FakeCloudflare) => fake.calls.map(c => c.method);

  it('a match is deleted (read first, then deleted)', async () => {
    const { fake, rec, cf } = setup();
    await expect(cf.deleteDnsRecord(Zid, rec.id, { type: 'TXT', name: 'x._report._dmarc.reports.acme.com', content: 'v=DMARC1;' })).resolves.toBe(true);
    expect(methods(fake)).toEqual(['GET', 'DELETE']);
    expect(fake.records.get(Zid)).toEqual([]);
  });

  it.each<[string, { type: string; name: string; content?: string | RegExp }]>([
    ['another name', { type: 'TXT', name: '_dmarc.reports.acme.com' }],
    ['other content', { type: 'TXT', name: 'x._report._dmarc.reports.acme.com', content: 'v=STSv1; id=1' }],
    ['other content (pattern)', { type: 'TXT', name: 'x._report._dmarc.reports.acme.com', content: /^v=STSv1/ }],
  ])('refuses when it expects %s: nothing is deleted', async (_t, expect_) => {
    const { fake, rec, cf } = setup();
    await expect(cf.deleteDnsRecord(Zid, rec.id, expect_)).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    expect(methods(fake)).toEqual(['GET']);
    expect(fake.records.get(Zid)).toHaveLength(1);
  });

  it('refuses when the stored record is of another type: nothing is deleted', async () => {
    const { fake, cf } = setup();
    const a = fake.seed(Zid, { type: 'A', name: 'x._report._dmarc.reports.acme.com', content: '192.0.2.1' });
    await expect(cf.deleteDnsRecord(Zid, a.id, { type: 'TXT', name: 'x._report._dmarc.reports.acme.com' })).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    expect(fake.records.get(Zid)).toHaveLength(2);
  });

  it('a record already gone (404 on the read) is treated as gone', async () => {
    const { fake, cf } = setup();
    await expect(cf.deleteDnsRecord(Zid, 'f'.repeat(32), { type: 'TXT', name: 'x._report._dmarc.reports.acme.com' })).resolves.toBe(false);
    expect(methods(fake)).toEqual(['GET']);
  });
});

describe('CfClient.listZones / listAccounts read every page', () => {
  it('zones: 120 zones are read in three pages, and a failing page is an error, not a short list', async () => {
    const zones = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i}.com`, { id: `id${i}` }]));
    const fake = new FakeCloudflare(zones);
    expect(await clientFor(fake).listZones()).toHaveLength(120);
    const inner = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (i, init) => new URL(String(i)).searchParams.get('page') === '2' ? new Response('{}', { status: 500 }) : inner(i, init));
    await expect(clientFor(fake).listZones()).rejects.toBeInstanceOf(CfApiError);
  });

  it('accounts: more than one page is followed', async () => {
    const fake = new FakeCloudflare({});
    fake.accounts = Array.from({ length: 70 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
    expect(await clientFor(fake).listAccounts()).toHaveLength(70);
  });
});
