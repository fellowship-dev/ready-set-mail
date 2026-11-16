// The Cloudflare stand-ins behave like the real API for TXT content (so what the SPF tests prove holds against Cloudflare):
// unquoted content is stored quoted; a string over 255 bytes is split into 255-byte strings; content comes back as `"a" "b"`.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { FakeCloudflare, cloudflareTxtContent, stubCloudflare } from '../helpers/cf-fake';
import { startFakeCloudflare } from '../../e2e/support/fake-cloudflare.mjs';

afterEach(() => vi.unstubAllGlobals());
const strings = (q: string) => [...q.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!);
const long = (n: number) => `v=spf1 ${Array.from({ length: Math.ceil(n / 12) }, (_, i) => `ip4:10.0.${i % 250}.1`).join(' ')}`.slice(0, n);

describe('cloudflareTxtContent', () => {
  it('quotes unquoted content', () => expect(cloudflareTxtContent('v=spf1 -all')).toBe('"v=spf1 -all"'));
  it('keeps quoted strings as they are', () => expect(cloudflareTxtContent('"a" "b"')).toBe('"a" "b"'));
  it('splits a string over 255 bytes into 255-byte strings', () => {
    for (const n of [256, 300, 449, 510, 511]) {
      const parts = strings(cloudflareTxtContent(long(n)));
      expect(parts.map(p => p.length)).toEqual([...Array(Math.floor(n / 255)).fill(255), ...(n % 255 ? [n % 255] : [])]);
      expect(parts.join('')).toBe(long(n));
    }
  });
  it('splits each over-long string of quoted content', () => {
    expect(strings(cloudflareTxtContent(`"${'a'.repeat(300)}" "b"`)).map(p => p.length)).toEqual([255, 45, 1]);
  });
});

describe('the unit stand-in (test/helpers/cf-fake.ts)', () => {
  it('stores and returns TXT the way Cloudflare does when realisticTxt is on, and leaves content alone otherwise', async () => {
    const cf = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    stubCloudflare(cf);
    const call = async (method: string, path: string, body?: unknown) => (await (await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { authorization: 'Bearer t' }, body: body ? JSON.stringify(body) : undefined })).json() as { result: { id: string; content: string } });
    expect((await call('POST', '/zones/z1/dns_records', { type: 'TXT', name: 'a.acme.com', content: 'v=spf1 -all' })).result.content).toBe('v=spf1 -all');
    cf.realisticTxt = true;
    const made = (await call('POST', '/zones/z1/dns_records', { type: 'TXT', name: 'b.acme.com', content: long(449) })).result;
    expect(strings(made.content).map(p => p.length)).toEqual([255, 194]);
    const patched = (await call('PATCH', `/zones/z1/dns_records/${made.id}`, { content: long(300) })).result;
    expect(strings(patched.content).map(p => p.length)).toEqual([255, 45]);
    expect(decodeTxtData((await call('GET', `/zones/z1/dns_records/${made.id}`)).result.content)).toBe(long(300));
    expect((await call('POST', '/zones/z1/dns_records', { type: 'MX', name: 'c.acme.com', content: 'mx.test' })).result.content).toBe('mx.test');
  });
});

describe('the e2e stand-in (e2e/support/fake-cloudflare.mjs)', () => {
  it('does the same once POST /__config {realisticTxt: true} says so; a /__reset turns it off', async () => {
    const fake = await startFakeCloudflare({ port: 0 });
    try {
      const api = async (method: string, path: string, body?: unknown) => (await (await fetch(`${fake.url}${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as any);
      const zone = (await api('GET', '/client/v4/zones?name=harbor-lane.org')).result[0];
      const plain = (await api('POST', `/client/v4/zones/${zone.id}/dns_records`, { type: 'TXT', name: 'x.harbor-lane.org', content: 'hello' })).result;
      expect(plain.content).toBe('hello');
      await api('POST', '/__config', { realisticTxt: true });
      const made = (await api('POST', `/client/v4/zones/${zone.id}/dns_records`, { type: 'TXT', name: 'y.harbor-lane.org', content: long(449) })).result;
      expect(strings(made.content).map(p => p.length)).toEqual([255, 194]);
      const list = (await api('GET', `/client/v4/zones/${zone.id}/dns_records?type=TXT&name=y.harbor-lane.org`)).result;
      expect(decodeTxtData(list[0].content)).toBe(long(449));
      const doh = await (await fetch(`${fake.url}/dns-query?name=y.harbor-lane.org&type=TXT`, { headers: { accept: 'application/dns-json' } })).json() as any;
      expect(decodeTxtData(doh.Answer[0].data)).toBe(long(449));
      await api('POST', '/__reset');
      expect((await api('POST', `/client/v4/zones/${zone.id}/dns_records`, { type: 'TXT', name: 'z.harbor-lane.org', content: 'plain' })).result.content).toBe('plain');
    } finally { await fake.close(); }
  });
});
