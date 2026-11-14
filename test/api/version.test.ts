// GET /api/version reports the update check (src/update-check.ts) and never reads the main branch.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleApi } from '../../src/api/router';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { RELEASES_API_URL, resetUpdateCheckCache } from '../../src/update-check';
import pkg from '../../package.json';

const release = (tag: string) => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }), { status: 200 });
const env = (extra: Record<string, string> = {}) => ({ DB: createMigratedD1() as unknown as D1Database, BOOTSTRAP_SECRET: 'test-only-installer-proof-32-characters-minimum', ...extra });
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const get = (e: ReturnType<typeof env>) => handleApi(new Request('https://rsm.example.com/api/version'), e as never, ctx);

afterEach(() => { vi.unstubAllGlobals(); resetUpdateCheckCache(); });

describe('GET /api/version', () => {
  it('reports the update check and never reads main', async () => {
    const f = vi.fn(async () => release('v99.0.0'));
    vi.stubGlobal('fetch', f);
    const res = await get(env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ current: pkg.version, latest: '99.0.0', status: 'newer', update_available: true, release_url: expect.stringContaining('/releases/tag/v99.0.0') });
    expect(f.mock.calls.map(c => String(c[0]))).toEqual([RELEASES_API_URL]);
  });
});

describe('GET /api/version off', () => {
  it('UPDATE_CHECK=off: no outbound call, status off', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await (await get(env({ UPDATE_CHECK: 'off' }))).json()).toMatchObject({ current: pkg.version, latest: null, status: 'off', update_available: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('GitHub unreachable: status unknown, not up to date', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await (await get(env())).json()).toMatchObject({ status: 'unknown', update_available: false, latest: null });
  });
});
