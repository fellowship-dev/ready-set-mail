// Who hosts a domain's DNS: the nameserver table, parent lookup, caching, and GET /api/domains/dns-host.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { fakeResolver, dohFetch, type Zone } from '../../packages/dns-checks/test/helpers';
import { DNS_PROVIDERS, __resetDnsHostCacheForTests, classifyNameservers, detectDnsHostFor } from '../../src/domains/dns-host';

beforeEach(() => __resetDnsHostCacheForTests());
afterEach(() => vi.unstubAllGlobals());

const detect = (zone: Zone, domain: string, calls: string[] = []) => detectDnsHostFor(domain, fakeResolver(zone, calls));

const SAMPLES: Record<string, string[]> = {
  cloudflare: ['ada.ns.cloudflare.com.', 'bob.ns.cloudflare.com.'],
  godaddy: ['ns47.domaincontrol.com.', 'ns48.domaincontrol.com.'],
  porkbun: ['curitiba.ns.porkbun.com.', 'fortaleza.ns.porkbun.com.'],
  namecheap: ['dns1.registrar-servers.com.', 'dns2.registrar-servers.com.'],
  route53: ['ns-2048.awsdns-64.com.', 'ns-1.awsdns-00.co.uk.'],
  'google-cloud-dns': ['ns-cloud-a1.googledomains.com.', 'ns-cloud-a2.googledomains.com.'],
  squarespace: ['ns1.squarespacedns.com.', 'ns2.squarespacedns.com.'],
  digitalocean: ['ns1.digitalocean.com.', 'ns2.digitalocean.com.', 'ns3.digitalocean.com.'],
  vercel: ['ns1.vercel-dns.com.', 'ns2.vercel-dns.com.'],
  ns1: ['dns1.p01.nsone.net.', 'dns2.p01.nsone.net.'],
};

describe('provider table', () => {
  it('every provider in the table has a sample and is recognised from it', async () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(DNS_PROVIDERS.map(p => p.id).sort());
    for (const [id, ns] of Object.entries(SAMPLES)) {
      __resetDnsHostCacheForTests();
      const r = await detect({ 'NS example.org': ns }, 'example.org');
      expect(r.status, id).toBe('known');
      expect(r.provider?.id, id).toBe(id);
      expect(r.nameservers.length).toBe(ns.length);
      expect(r.nameservers.every(n => !n.endsWith('.'))).toBe(true);
    }
  });

  it('carries help_url and host_field only where confirmed, and never leaks the pattern', async () => {
    const gd = (await detect({ 'NS example.org': SAMPLES.godaddy }, 'example.org')).provider!;
    expect(gd).toEqual({ id: 'godaddy', name: 'GoDaddy', help_url: 'https://www.godaddy.com/help/add-a-txt-record-19232', host_field: 'relative' });
    const cf = (await detect({ 'NS example.net': SAMPLES.cloudflare }, 'example.net')).provider!;
    expect(cf).toEqual({ id: 'cloudflare', name: 'Cloudflare' });
    for (const p of DNS_PROVIDERS) if (p.help_url) expect(p.help_url).toMatch(/^https:\/\//);
  });

  it('look-alikes are not matched', () => {
    for (const ns of ['ns1.cloudflare.com.evil.example', 'ns.cloudflare.com', 'ns1.notdomaincontrol.com', 'ns-1.awsdns-1.example.com', 'a.nsone.net.example.org']) {
      expect(classifyNameservers([ns]).status, ns).toBe('unknown');
    }
  });
});

describe('outcomes', () => {
  it('unknown nameservers: unknown, nameservers listed, no provider', async () => {
    expect(await detect({ 'NS acme.com': ['ns1.selfhosted.example.', 'ns2.selfhosted.example.'] }, 'acme.com'))
      .toEqual({ provider: null, nameservers: ['ns1.selfhosted.example', 'ns2.selfhosted.example'], status: 'unknown' });
  });

  it('two providers: mixed, provider null, both listed', async () => {
    const r = await detect({ 'NS acme.com': ['ada.ns.cloudflare.com.', 'ns1.digitalocean.com.'] }, 'acme.com');
    expect(r.status).toBe('mixed');
    expect(r.provider).toBeNull();
    expect(r.providers).toEqual([{ id: 'cloudflare', name: 'Cloudflare' }, { id: 'digitalocean', name: 'DigitalOcean' }]);
  });

  it('a subdomain with no NS of its own uses the nearest parent that has one', async () => {
    const calls: string[] = [];
    const r = await detect({ 'NS acme.com': SAMPLES.namecheap }, 'a.b.acme.com', calls);
    expect(r.provider?.id).toBe('namecheap');
    expect(calls).toEqual(['NS a.b.acme.com', 'NS b.acme.com', 'NS acme.com']);
    // a delegated subdomain is its own answer
    __resetDnsHostCacheForTests();
    expect((await detect({ 'NS acme.com': SAMPLES.namecheap, 'NS b.acme.com': SAMPLES.vercel }, 'a.b.acme.com')).provider?.id).toBe('vercel');
  });

  it('a name with no NS anywhere is unknown, not an error', async () => {
    expect((await detect({}, 'nothing.example.org')).status).toBe('unknown');
  });

  it('a failed lookup is error (never unknown), also when only the parent fails, and is not cached', async () => {
    for (const bad of ['SERVFAIL', 'TIMEOUT', 'HTTP500', 'GARBAGE'] as const) {
      const r = await detect({ 'NS acme.com': bad }, 'acme.com');
      expect(r, bad).toEqual({ provider: null, nameservers: [], status: 'error' });
    }
    expect((await detect({ 'NS sub.acme.com': 'NODATA', 'NS acme.com': 'SERVFAIL' }, 'sub.acme.com')).status).toBe('error');
    const calls: string[] = [];
    await detect({ 'NS acme.com': 'SERVFAIL' }, 'acme.com', calls);
    await detect({ 'NS acme.com': SAMPLES.vercel }, 'acme.com', calls);
    expect(calls).toEqual(['NS acme.com', 'NS acme.com']);
    expect((await detect({ 'NS acme.com': SAMPLES.vercel }, 'acme.com')).status).toBe('known');
  });
});

describe('cache', () => {
  it('answers from cache for an hour, then asks again', async () => {
    const calls: string[] = [];
    const r = fakeResolver({ 'NS acme.com': SAMPLES.porkbun }, calls);
    const t = 1_000_000;
    await detectDnsHostFor('acme.com', r, t);
    await detectDnsHostFor('ACME.com.', r, t + 59 * 60_000);
    expect(calls).toEqual(['NS acme.com']);
    await detectDnsHostFor('acme.com', r, t + 61 * 60_000);
    expect(calls).toEqual(['NS acme.com', 'NS acme.com']);
  });
});

describe('GET /api/domains/dns-host', () => {
  async function world(extra: Record<string, unknown> = {}) {
    const db = createMigratedD1();
    const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
    const token = await signupVerified(env, 'a@example.com');
    return { env, token };
  }
  const stub = (zone: Zone, calls: string[] = []) => vi.stubGlobal('fetch', dohFetch(zone, calls));

  it('a member gets the provider; the answer is public NS only', async () => {
    const w = await world();
    stub({ 'NS acme.com': SAMPLES.namecheap });
    const res = await call(w.env, 'GET', '/api/domains/dns-host?name=Acme.com', { key: w.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'known', provider: { id: 'namecheap', name: 'Namecheap', host_field: 'relative' }, nameservers: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'] });
  });

  it('rejects a missing or invalid name with 400, and no session with 401', async () => {
    const w = await world();
    stub({});
    for (const q of ['', '?name=', '?name=not%20a%20domain', '?name=localhost', '?name=1.2.3.4']) {
      expect((await call(w.env, 'GET', `/api/domains/dns-host${q}`, { key: w.token })).status, q).toBe(400);
    }
    expect((await call(w.env, 'GET', '/api/domains/dns-host?name=acme.com')).status).toBe(401);
  });

  it('a lookup failure is reported as error', async () => {
    const w = await world();
    stub({ 'NS acme.com': 'SERVFAIL' });
    expect(await (await call(w.env, 'GET', '/api/domains/dns-host?name=acme.com', { key: w.token })).json()).toMatchObject({ status: 'error', provider: null });
  });

  it('is limited with DNS_PREVIEW_LIMITER, and a cached answer costs no allowance', async () => {
    let allowed = true;
    const limit = vi.fn(async () => ({ success: allowed }));
    const w = await world({ DNS_PREVIEW_LIMITER: { limit } });
    stub({ 'NS acme.com': SAMPLES.vercel, 'NS other.com': SAMPLES.vercel });
    expect((await call(w.env, 'GET', '/api/domains/dns-host?name=acme.com', { key: w.token })).status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(1);
    expect((await call(w.env, 'GET', '/api/domains/dns-host?name=acme.com', { key: w.token })).status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(1);
    allowed = false;
    const res = await call(w.env, 'GET', '/api/domains/dns-host?name=other.com', { key: w.token });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
  });
});
