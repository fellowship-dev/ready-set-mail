// The claim Verify button reads DNS through resolverFor(env): with DOH_BASE_URL set (local runs, tests) it never reaches public DNS.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';

afterEach(() => vi.restoreAllMocks());
const json = async (r: Response) => await r.json() as any;

async function run(extra: Record<string, unknown>) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
  const token = await signupVerified(env, 'a@example.com');
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ Status: 3 }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } }); });
  const claim = (await json(await call(env, 'POST', '/api/domains', { key: token, body: { domain: 'acme.com' } }))).claim as { id: number };
  urls.length = 0;
  const res = await call(env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token });
  return { res, urls };
}

describe('Verify of a pending claim uses the DoH override', () => {
  it('DOH_BASE_URL (localhost): every lookup goes there, none to public DNS', async () => {
    const { urls } = await run({ DOH_BASE_URL: 'http://127.0.0.1:8799' });
    const dns = urls.filter(u => /dns-query/.test(u));
    expect(dns.length).toBeGreaterThan(0);
    expect(dns.every(u => u.startsWith('http://127.0.0.1:8799/dns-query'))).toBe(true);
    expect(urls.some(u => /cloudflare-dns\.com|dns\.google/.test(u))).toBe(false);
  });

  it('without the override the public resolver is used', async () => {
    const { urls } = await run({});
    expect(urls.some(u => /cloudflare-dns\.com/.test(u))).toBe(true);
  });
});
