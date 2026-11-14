// The update check compares the running version with the latest PUBLISHED GitHub release (src/update-check.ts):
// semantic versions, cached, failing quiet, switchable off, never reading the main branch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkForUpdate, compareSemver, parseSemver, resetUpdateCheckCache, updateCheckEnabled,
  RELEASES_API_URL, RELEASES_LATEST_URL, UPDATE_CHECK_KV_KEY, ANSWER_TTL_S, FAILURE_TTL_S,
} from '../src/update-check';
import { buildDigestBody } from '../src/digest/weekly';
import { buildWeeklyDigestHtml } from '../src/email/html-templates';
import { PRODUCT_VERSION } from '../src/version';
import pkg from '../package.json';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const release = (tag: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, ...extra }), { status: 200 });
const fetchReturning = (...responses: (Response | Error)[]) => {
  const f = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return f as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};

class MemoryKV {
  store = new Map<string, { value: string; ttl?: number }>();
  get = vi.fn(async (key: string) => this.store.get(key)?.value ?? null);
  put = vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => { this.store.set(key, { value, ttl: opts?.expirationTtl }); });
}
const kvEnv = (kv: MemoryKV, extra: Record<string, string> = {}) => ({ OAUTH_KV: kv as unknown as KVNamespace, ...extra });

beforeEach(() => resetUpdateCheckCache());
afterEach(() => vi.unstubAllGlobals());

describe('semantic versions', () => {
  it('parses versions with and without v, rejects anything else', () => {
    expect(parseSemver('2.0.0')).toEqual({ major: 2, minor: 0, patch: 0, pre: [] });
    expect(parseSemver('v2.10.3-rc.1+build.5')).toEqual({ major: 2, minor: 10, patch: 3, pre: ['rc', '1'] });
    for (const bad of ['', 'latest', 'v2', '2.0', '02.0.0', '2.0.0.1', '2.0.0-', ' v 2.0.0', 'x'.repeat(80)]) expect(parseSemver(bad), bad).toBeNull();
  });

  it('orders by precedence, numerically (not as strings), with pre-releases before the release', () => {
    const cmp = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(cmp('1.2.0', '2.0.0')).toBe(-1);
    expect(cmp('2.0.0', '2.0.0')).toBe(0);
    expect(cmp('2.0.0+abc', '2.0.0')).toBe(0);
    expect(cmp('2.10.0', '2.9.0')).toBe(1);
    expect(cmp('2.1.0-beta.1', '2.1.0')).toBe(-1);
    expect(cmp('2.1.0-beta.2', '2.1.0-beta.10')).toBe(-1);
    expect(cmp('2.1.0-alpha', '2.1.0-alpha.1')).toBe(-1);
    expect(cmp('2.1.0-1', '2.1.0-alpha')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  it('newer: a newer published release is available, with its notes and upgrade guide at the tag', async () => {
    const f = fetchReturning(release('v2.1.0'));
    const info = await checkForUpdate({}, { fetch: f, now: NOW, current: '2.0.0' });
    expect(info).toEqual({
      current: '2.0.0', latest: '2.1.0', status: 'newer', update_available: true,
      release_url: 'https://github.com/fellowship-dev/ready-set-mail/releases/tag/v2.1.0',
      upgrade_url: 'https://github.com/fellowship-dev/ready-set-mail/blob/v2.1.0/packages/db/UPGRADING.md',
      checked_at: NOW / 1000,
    });
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RELEASES_API_URL);
    expect(url).not.toMatch(/main|raw\.githubusercontent/);
    // A plain GET: no credentials and nothing that identifies the installation.
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map(h => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version']);
    expect(headers['User-Agent']).toBe('ready-set-mail-update-check');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('same: up to date', async () => {
    const info = await checkForUpdate({}, { fetch: fetchReturning(release('v2.0.0')), now: NOW, current: '2.0.0' });
    expect(info).toMatchObject({ latest: '2.0.0', status: 'same', update_available: false });
  });

  it('older: running ahead of the latest release (for example main) is never told to "update" backwards', async () => {
    const info = await checkForUpdate({}, { fetch: fetchReturning(release('v2.0.0')), now: NOW, current: '2.1.0-dev' });
    expect(info).toMatchObject({ latest: '2.0.0', status: 'older', update_available: false });
    resetUpdateCheckCache();
    expect(await checkForUpdate({}, { fetch: fetchReturning(release('v1.2.0')), now: NOW, current: '2.0.0' })).toMatchObject({ status: 'older', update_available: false });
  });

  it('compares numerically: 2.10.0 is newer than 2.9.0', async () => {
    expect(await checkForUpdate({}, { fetch: fetchReturning(release('v2.10.0')), now: NOW, current: '2.9.0' })).toMatchObject({ status: 'newer' });
  });

  it('a malformed tag, a pre-release, a draft or no release at all is "unknown", not "up to date"', async () => {
    for (const res of [release('latest'), release('v2'), release(42), release('v3.0.0-rc.1'), release('v3.0.0', { prerelease: true }), release('v3.0.0', { draft: true }), new Response('not json', { status: 200 }), new Response('{}', { status: 404 })]) {
      resetUpdateCheckCache();
      const info = await checkForUpdate({}, { fetch: fetchReturning(res), now: NOW, current: '2.0.0' });
      expect(info).toMatchObject({ latest: null, status: 'unknown', update_available: false, release_url: RELEASES_LATEST_URL });
    }
  });

  it('network failure and timeouts fail quiet: "unknown"', async () => {
    for (const failure of [new TypeError('fetch failed'), Object.assign(new Error('timed out'), { name: 'TimeoutError' }), new Response('', { status: 500 }), new Response('', { status: 502 })]) {
      resetUpdateCheckCache();
      const info = await checkForUpdate({}, { fetch: fetchReturning(failure), now: NOW, current: '2.0.0' });
      expect(info).toMatchObject({ latest: null, status: 'unknown', update_available: false, checked_at: NOW / 1000 });
    }
  });

  it('rate-limited API: falls back to the releases/latest redirect', async () => {
    const f = fetchReturning(
      new Response('{"message":"API rate limit exceeded"}', { status: 403 }),
      new Response(null, { status: 302, headers: { location: 'https://github.com/fellowship-dev/ready-set-mail/releases/tag/v2.1.0' } }),
    );
    const info = await checkForUpdate({}, { fetch: f, now: NOW, current: '2.0.0' });
    expect(info).toMatchObject({ latest: '2.1.0', status: 'newer' });
    expect(f.mock.calls.map(c => c[0])).toEqual([RELEASES_API_URL, RELEASES_LATEST_URL]);
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('rate-limited API and page: "unknown", cached for an hour, not re-asked per page view', async () => {
    const f = fetchReturning(new Response('', { status: 429 }), new Response('', { status: 429 }));
    expect(await checkForUpdate({}, { fetch: f, now: NOW, current: '2.0.0' })).toMatchObject({ status: 'unknown' });
    expect(await checkForUpdate({}, { fetch: f, now: NOW + (FAILURE_TTL_S - 1) * 1000, current: '2.0.0' })).toMatchObject({ status: 'unknown' });
    expect(f).toHaveBeenCalledTimes(2);
    // After the hour it asks again.
    const g = fetchReturning(release('v2.0.0'));
    expect(await checkForUpdate({}, { fetch: g, now: NOW + FAILURE_TTL_S * 1000, current: '2.0.0' })).toMatchObject({ status: 'same' });
    expect(g).toHaveBeenCalledOnce();
  });

  it('a redirect to the releases list (no release) is "unknown"', async () => {
    const f = fetchReturning(new Response('', { status: 403 }), new Response(null, { status: 302, headers: { location: '/fellowship-dev/ready-set-mail/releases' } }));
    expect(await checkForUpdate({}, { fetch: f, now: NOW, current: '2.0.0' })).toMatchObject({ status: 'unknown' });
  });

  it('cache hit: one GitHub call for many page views, in memory and through OAUTH_KV across isolates', async () => {
    const kv = new MemoryKV();
    const f = fetchReturning(release('v2.1.0'));
    for (let i = 0; i < 5; i++) expect(await checkForUpdate(kvEnv(kv), { fetch: f, now: NOW + i * 60_000, current: '2.0.0' })).toMatchObject({ status: 'newer' });
    expect(f).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
    expect(kv.store.get(UPDATE_CHECK_KV_KEY)?.ttl).toBe(ANSWER_TTL_S);

    // A new isolate (empty memory) reads KV instead of GitHub.
    resetUpdateCheckCache();
    const none = fetchReturning();
    expect(await checkForUpdate(kvEnv(kv), { fetch: none, now: NOW + 3600_000, current: '2.0.0' })).toMatchObject({ status: 'newer', latest: '2.1.0' });
    expect(none).not.toHaveBeenCalled();

    // Expired: asks again.
    const again = fetchReturning(release('v2.2.0'));
    expect(await checkForUpdate(kvEnv(kv), { fetch: again, now: NOW + ANSWER_TTL_S * 1000, current: '2.0.0' })).toMatchObject({ latest: '2.2.0' });
    expect(again).toHaveBeenCalledOnce();
  });

  it('concurrent page views share one request', async () => {
    const f = fetchReturning(release('v2.1.0'));
    const all = await Promise.all([1, 2, 3].map(() => checkForUpdate({}, { fetch: f, now: NOW, current: '2.0.0' })));
    expect(all.map(a => a.status)).toEqual(['newer', 'newer', 'newer']);
    expect(f).toHaveBeenCalledOnce();
  });

  it('a corrupt KV entry is ignored; a KV failure never breaks the check', async () => {
    const kv = new MemoryKV();
    kv.store.set(UPDATE_CHECK_KV_KEY, { value: '{"outcome":"release","tag":"<script>","checked_at":0}' });
    kv.put.mockRejectedValueOnce(new Error('kv down'));
    expect(await checkForUpdate(kvEnv(kv), { fetch: fetchReturning(release('v2.0.0')), now: NOW, current: '2.0.0' })).toMatchObject({ status: 'same' });
  });

  it('off: UPDATE_CHECK=off and MODE=saas make no outbound call', async () => {
    for (const env of [{ UPDATE_CHECK: 'off' }, { UPDATE_CHECK: 'FALSE' }, { UPDATE_CHECK: '0' }, { UPDATE_CHECK: 'no' }, { MODE: 'saas' }]) {
      const f = fetchReturning();
      expect(updateCheckEnabled(env)).toBe(false);
      expect(await checkForUpdate(env, { fetch: f, now: NOW, current: '2.0.0' })).toMatchObject({ status: 'off', latest: null, update_available: false, checked_at: null });
      expect(f).not.toHaveBeenCalled();
    }
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ UPDATE_CHECK: 'on' })).toBe(true);
  });

  it('defaults to the product version and the global fetch', async () => {
    const f = fetchReturning(release(`v${PRODUCT_VERSION}`));
    vi.stubGlobal('fetch', f);
    expect(await checkForUpdate({}, { now: NOW })).toMatchObject({ current: pkg.version, status: 'same' });
    expect(f).toHaveBeenCalledOnce();
  });
});

describe('digest update notice', () => {
  const update = { current: '2.0.0', latest: '2.1.0', release_url: 'https://github.com/fellowship-dev/ready-set-mail/releases/tag/v2.1.0', upgrade_url: 'https://github.com/fellowship-dev/ready-set-mail/blob/v2.1.0/packages/db/UPGRADING.md' };

  it('names the version and links the notes and the upgrade guide', () => {
    const text = buildDigestBody('Acme', [], new Map(), 'Nov 9, 2026', 'rua@reports.example.com', 'reports.example.com', update);
    expect(text).toContain('v2.1.0 is available');
    expect(text).toContain(update.release_url);
    expect(text).toContain(update.upgrade_url);
    const html = buildWeeklyDigestHtml({ recipientName: 'Acme', stats: [], sourcesByDomain: new Map(), weekLabel: 'Nov 9, 2026', ruaAddress: 'rua@reports.example.com', reportsDomain: 'reports.example.com', update });
    expect(html).toContain('v2.1.0 is available');
    expect(html).toContain(`href="${update.upgrade_url}"`);
  });

  it('says nothing without an update', () => {
    expect(buildDigestBody('Acme', [], new Map(), 'Nov 9, 2026', 'rua@reports.example.com', 'reports.example.com', null)).not.toContain('is available');
    expect(buildWeeklyDigestHtml({ recipientName: 'Acme', stats: [], sourcesByDomain: new Map(), weekLabel: 'Nov 9, 2026', ruaAddress: 'rua@reports.example.com', reportsDomain: 'reports.example.com', update: null })).not.toContain('is available');
  });
});
