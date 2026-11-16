// Product analytics (docs/analytics.md): off by default, the allow-list, the send itself, and the forbidden-property checks of
// ticket A7: over every event and value the code can send, over every call site in src/, and over a full fixture walk.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { EVENTS, allowed, countBucket, codeWait, longWait, shortWait, triesBucket, resendsBucket, issuesBucket } from '../../src/product-analytics/events';
import { ALLOWED_HOSTS, analyticsConfig, analyticsState, batchBody, capture, captureLater, captureMany, ev, send, toSecond, RETRY_DELAY_MS } from '../../src/product-analytics/capture';
import { adoptAnalyticsId, analyticsIdFor, mintedId } from '../../src/product-analytics/identity';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { POSTHOG_HOST, POSTHOG_KEY, SECRETS, STRAY_VID, runWalk } from './walk';

/** An analytics id as this Worker mints them (the tests' fixed one). */
const VISITOR_ID = '7d0c6c2e-1b9a-4f3e-9c2d-5a6b7c8d9e0f';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const ON = { MODE: 'saas', POSTHOG_KEY, POSTHOG_HOST };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * What must never appear in anything sent to PostHog (ticket A7): an email address, a domain-like name, an IPv4 or IPv6 address, an
 * SPF or DMARC record, an ownership token, a Stripe or Cloudflare or workspace or order id. UUIDs are checked separately: only the
 * analytics ids may appear.
 */
export const FORBIDDEN: [string, RegExp][] = [
  ['email', /[^\s@"]+@[^\s@"]+/],
  ['domain', /[a-z0-9-]+\.[a-z]{2,}/i],
  ['ipv4', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ['ipv6', /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i],
  ['spf', /v=spf1/i],
  ['dmarc', /v=DMARC1/i],
  ['ownership token', /readysetmail-verify=|_readysetmail/i],
  ['stripe id', /\b(?:cus|in|pi|ch|pm|seti|cs|re|price|prod|evt|whsec|rk|sk)_[A-Za-z0-9]{6,}/],
  ['our ids', /\b(?:ws|ord|bcs)_[0-9a-f]{8,}/],
  ['32+ hex (zone/account ids, hashes)', /\b[0-9a-f]{32,}\b/i],
];

/** Every value (strings and keys) in a JSON payload, except the ones that are allowed to be ids. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

function violations(payload: unknown, allowedIds: Set<string>): string[] {
  const p = JSON.parse(JSON.stringify(payload)) as { api_key?: string; batch?: { distinct_id?: string; timestamp?: string }[] };
  const found: string[] = [];
  for (const e of p.batch ?? []) {
    if (!allowedIds.has(e.distinct_id ?? '')) found.push(`distinct_id ${e.distinct_id} is not an analytics id`);
    delete e.distinct_id;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.timestamp ?? '')) found.push(`timestamp ${e.timestamp}`); // whole seconds
    delete e.timestamp;
  }
  delete p.api_key;
  for (const s of strings(p)) {
    for (const [name, re] of FORBIDDEN) if (re.test(s)) found.push(`${name}: ${s}`);
    if ((s.match(UUID) ?? []).length) found.push(`uuid: ${s}`);
  }
  return found;
}

describe('off by default', () => {
  it('sends nothing unless MODE=saas and both POSTHOG_KEY and POSTHOG_HOST are set', () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ MODE: 'saas' })).toBeNull(); // hosted alone does not turn it on
    expect(analyticsConfig({ MODE: 'saas', POSTHOG_KEY })).toBeNull();
    expect(analyticsConfig({ MODE: 'saas', POSTHOG_HOST })).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY, POSTHOG_HOST })).toBeNull(); // self-host: never, whatever is set
    expect(analyticsConfig({ MODE: 'selfhost', POSTHOG_KEY, POSTHOG_HOST })).toBeNull();
    expect(analyticsConfig(ON)).toEqual({ key: POSTHOG_KEY, batchUrl: 'https://us.i.posthog.com/batch/' });
    expect(analyticsConfig({ ...ON, POSTHOG_HOST: 'https://us.i.posthog.com/' })?.batchUrl).toBe('https://us.i.posthog.com/batch/');
    expect(analyticsConfig({ ...ON, POSTHOG_HOST: 'https://eu.i.posthog.com' })?.batchUrl).toBe('https://eu.i.posthog.com/batch/');
  });

  it('refuses a key that is not a project key', () => {
    for (const key of ['phx_personalkey0123456789', 'sk_live_x', 'phc_', ' ']) expect(analyticsConfig({ ...ON, POSTHOG_KEY: key }), key).toBeNull();
  });

  it('sends only to PostHog\'s own ingestion hosts, origin only: never a proxy on our own zone (it would forward the visitor\'s IP), never a path', () => {
    expect(ALLOWED_HOSTS).toEqual(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
    const refused = [
      'https://app.readysetmail.com/ingest', 'https://app.readysetmail.com', 'https://readysetmail.com/ingest', 'https://e.readysetmail.com',
      'https://us.i.posthog.com/ingest', 'https://us.i.posthog.com/batch/', 'https://us.i.posthog.com:8443', 'https://us.posthog.com', 'https://app.posthog.com',
      'https://us.i.posthog.com.evil.example', 'https://10.0.0.1', 'https://169.254.169.254', 'https://ph.example.com',
      'http://us.i.posthog.com', 'ftp://x.test', 'https://user:pw@us.i.posthog.com', 'https://us.i.posthog.com/?a=1', 'https://us.i.posthog.com/#x', 'not a url',
      'http://localhost', 'http://127.0.0.1', 'http://127.0.0.1:9999/ingest', 'http://10.0.0.1:8000', 'http://127.0.0.1:9999', 'http://localhost:9999',
    ];
    for (const host of refused) {
      expect(analyticsConfig({ ...ON, POSTHOG_HOST: host }), host).toBeNull();
      expect(analyticsState({ ...ON, POSTHOG_HOST: host }), host).toMatchObject({ state: 'misconfigured', setting: 'POSTHOG_HOST', reason: expect.stringContaining('never through a proxy on our own domain') });
    }
  });

  it('a loopback address in POSTHOG_HOST is a misconfiguration that names the test setting, and nothing is sent', async () => {
    const env = { ...ON, POSTHOG_HOST: 'http://127.0.0.1:9999' };
    expect(analyticsState(env)).toMatchObject({ state: 'misconfigured', setting: 'POSTHOG_HOST', reason: expect.stringContaining('POSTHOG_API_BASE') });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    await send(env, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: { method: 'code' } }]);
    capture(env, undefined, { analyticsId: VISITOR_ID }, 'Signed In', { method: 'code' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTHOG_API_BASE (testing only), a loopback origin, sends the batch there instead of to PostHog', async () => {
    for (const base of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://127.0.0.1:9999/', ' http://127.0.0.1:9999 ']) {
      const env = { ...ON, POSTHOG_API_BASE: base };
      expect(analyticsState(env), base).toMatchObject({ state: 'on' });
      const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
      vi.stubGlobal('fetch', fetchSpy);
      await send(env, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: { method: 'code' } }]);
      expect(fetchSpy.mock.calls.map((c) => c[0]), base).toEqual([`http://${base.trim().replace(/^http:\/\//, '').replace(/\/$/, '')}/batch/`]);
    }
    expect(analyticsConfig({ ...ON, POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_API_BASE: 'http://localhost:1234' })?.batchUrl).toBe('http://localhost:1234/batch/');
    expect(analyticsConfig({ ...ON, POSTHOG_API_BASE: '' })?.batchUrl).toBe('https://us.i.posthog.com/batch/'); // blank is unset
  });

  it('POSTHOG_API_BASE that is not a loopback origin turns analytics off: nothing is sent anywhere, never the real host', async () => {
    const refused = ['https://evil.example', 'https://us.i.posthog.com', 'http://evil.example:9999', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:9999/ingest', 'http://127.0.0.1:9999/?a=1', 'http://127.0.0.1:9999/#x',
      'http://user:pw@127.0.0.1:9999', 'https://127.0.0.1:9999', 'http://127.0.0.1.evil.example:9999', 'http://10.0.0.1:9999', 'http://[::1]:9999', 'nonsense', 123, null, {}];
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    for (const base of refused) {
      const env = { ...ON, POSTHOG_API_BASE: base };
      expect(analyticsConfig(env), String(base)).toBeNull();
      const state = analyticsState(env);
      expect(state, String(base)).toMatchObject({ state: 'misconfigured', setting: 'POSTHOG_API_BASE' });
      expect(JSON.stringify(state)).not.toContain('evil');
      await send(env, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: { method: 'code' } }]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTHOG_API_BASE alone does not turn analytics on: with the key or host unset, or on self-host, it is off', async () => {
    const base = 'http://127.0.0.1:9999';
    expect(analyticsState({ MODE: 'saas', POSTHOG_API_BASE: base })).toEqual({ state: 'off' });
    expect(analyticsState({ MODE: 'saas', POSTHOG_KEY, POSTHOG_API_BASE: base })).toMatchObject({ state: 'misconfigured', setting: 'POSTHOG_HOST' });
    expect(analyticsState({ MODE: 'saas', POSTHOG_HOST, POSTHOG_API_BASE: base })).toMatchObject({ state: 'misconfigured', setting: 'POSTHOG_KEY' });
    expect(analyticsState({ POSTHOG_KEY, POSTHOG_HOST, POSTHOG_API_BASE: base })).toEqual({ state: 'off' });
    expect(analyticsState({ MODE: 'selfhost', POSTHOG_KEY, POSTHOG_HOST, POSTHOG_API_BASE: base })).toEqual({ state: 'off' });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    await send({ MODE: 'saas', POSTHOG_API_BASE: base }, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: { method: 'code' } }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the owner\'s setup check says why analytics is off when a setting is present but wrong, and never shows a value', async () => {
    const { instancePreflight } = await import('../../src/setup/preflight');
    const env = (extra: Record<string, unknown>) => ({ DB: createMigratedD1() as unknown as D1Database, MODE: 'saas', SAAS_ENABLED: '1', ...extra }) as never;
    const item = async (extra: Record<string, unknown>) => (await instancePreflight(env(extra), 'https://ia.example.com')).items.find((i) => i.id === 'product_analytics');
    expect(await item({})).toBeUndefined(); // not set at all: off, nothing to say
    expect(await item({ POSTHOG_KEY, POSTHOG_HOST })).toBeUndefined(); // on
    const proxied = await item({ POSTHOG_KEY, POSTHOG_HOST: 'https://app.readysetmail.com/ingest' });
    expect(proxied).toMatchObject({ severity: 'note', setting: 'POSTHOG_HOST', message: expect.stringMatching(/us\.i\.posthog\.com or https:\/\/eu\.i\.posthog\.com.*visitor's IP address/) });
    expect(JSON.stringify(proxied)).not.toContain('readysetmail.com/ingest');
    expect(await item({ POSTHOG_KEY: 'phx_personal0123456789', POSTHOG_HOST })).toMatchObject({ setting: 'POSTHOG_KEY' });
    expect(JSON.stringify(await item({ POSTHOG_KEY: 'phx_personal0123456789', POSTHOG_HOST }))).not.toContain('phx_personal0123456789');
    expect(await item({ POSTHOG_KEY: 123, POSTHOG_HOST })).toMatchObject({ setting: 'POSTHOG_KEY' });
    expect(await item({ POSTHOG_HOST })).toMatchObject({ setting: 'POSTHOG_KEY' });
    const loop = await item({ POSTHOG_KEY, POSTHOG_HOST: 'http://127.0.0.1:9999' });
    expect(loop).toMatchObject({ setting: 'POSTHOG_HOST', message: expect.stringContaining('POSTHOG_API_BASE') });
    expect(JSON.stringify(loop)).not.toContain('9999');
    const base = await item({ POSTHOG_KEY, POSTHOG_HOST, POSTHOG_API_BASE: 'https://evil.example' });
    expect(base).toMatchObject({ severity: 'note', setting: 'POSTHOG_API_BASE', message: expect.stringContaining('testing only') });
    expect(JSON.stringify(base)).not.toContain('evil');
    expect(await item({ POSTHOG_KEY, POSTHOG_HOST, POSTHOG_API_BASE: 'http://127.0.0.1:9999' })).toBeUndefined(); // a valid fake: on
  });

  it('a hosted sign-up without the keys makes no PostHog request and stores no analytics id; nor does a self-host with them', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const env = makeEnv(createMigratedD1(), { MODE: 'saas', SAAS_ENABLED: '1' });
    await signupVerified(env, 'off@example.com');
    const self = makeEnv(createMigratedD1(), { POSTHOG_KEY, POSTHOG_HOST });
    const res = await call(self, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    expect(res.status).toBe(201);
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('posthog') || String(c[0]).includes('ph.fake'))).toEqual([]);
    for (const e of [env, self]) expect((e.DB as any).sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'analytics_id' OR key LIKE 'analytics:%'").get().n).toBe(0);
    expect(((await (await call(env, 'GET', '/api/auth/status')).json()) as any).product_analytics).toBe(false);
  });
});

describe('the installer and the defaults', () => {
  it('npm run setup never sets POSTHOG_KEY or POSTHOG_HOST, and wrangler.jsonc does not set them as vars', () => {
    const root = join(import.meta.dirname, '../..');
    const setup = [join(root, 'scripts/setup.mjs'), ...readdirSync(join(root, 'scripts/setup')).map((f) => join(root, 'scripts/setup', f))].filter((f) => statSync(f).isFile());
    for (const f of setup) expect(readFileSync(f, 'utf8'), f).not.toMatch(/POSTHOG/);
    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(wrangler).not.toMatch(/POSTHOG/);
  });
});

describe('the allow-list', () => {
  it('keeps only named properties with listed values', () => {
    expect(allowed('Signup Started', { entry: 'checker', method: 'email_code', from_checker: true, visitor_id: 'passed', vid: VISITOR_ID, email: 'a@b.com', extra: 1 })).toEqual({ entry: 'checker', method: 'email_code', from_checker: true });
    expect(allowed('Signup Started', { entry: 'example.com' })).toEqual({});
    expect(allowed('Code Verified', { from_checker: 'yes', account_created: true })).toEqual({ account_created: true });
    expect(allowed('Not An Event', { a: 'b' })).toBeNull();
  });

  it('drops every forbidden value, whichever property of whichever event it is put in', () => {
    const hostile = ['founder@acme-walk.com', 'acme-walk.com', '203.0.113.7', '2001:db8::1', 'v=spf1 -all', 'v=DMARC1; p=none', 'readysetmail-verify=abc', 'cus_ABC123456', 'ws_0123456789abcdef', VISITOR_ID, 'Acme Walk Ltd', 'a'.repeat(32)];
    for (const [event, shape] of Object.entries(EVENTS)) {
      for (const key of [...Object.keys(shape), '$ip', 'ip', 'user_agent', 'email', 'domain', 'name']) {
        for (const value of hostile) expect(allowed(event, { [key]: value }), `${event}.${key}=${value}`).toEqual({});
      }
    }
  });

  it('no value the table allows, and no property name, looks like anything forbidden', () => {
    for (const [event, shape] of Object.entries(EVENTS)) {
      for (const [key, rule] of Object.entries(shape)) {
        for (const value of rule === 'bool' ? ['true'] : (rule as readonly string[])) {
          for (const [name, re] of FORBIDDEN) expect(re.test(value) || re.test(key) || re.test(event), `${event}.${key}=${value} matches ${name}`).toBe(false);
        }
      }
    }
  });

  it('names are Title Case "Object Verb"', () => {
    for (const event of Object.keys(EVENTS)) expect(event).toMatch(/^[A-Z][a-z0-9]*( [A-Z0-9][a-z0-9]*)+$/);
  });

  it('buckets: numbers become labels', () => {
    expect([0, 1, 2, 5, 6, 20, 21, 500].map(countBucket)).toEqual(['0', '1', '2-5', '2-5', '6-20', '6-20', '21+', '21+']);
    expect([1, 2, 3, 9].map(triesBucket)).toEqual(['1', '2', '3+', '3+']);
    expect([0, 1, 4].map(resendsBucket)).toEqual(['0', '1', '2+']);
    expect([null, 0, 1, 2].map(issuesBucket)).toEqual(['unknown', '0', '1', '2']);
    expect([10, 100, 600, 1800, 7200].map(codeWait)).toEqual(['under_1m', '1_5m', '5_15m', '15_60m', 'over_1h']);
    expect([null, 30, 300, 1200, 7200, 90000].map(shortWait)).toEqual(['none', 'under_1m', '1_10m', '10_60m', '1_24h', 'over_24h']);
    expect([null, 60, 7200, 100000, 180000, 260000, 900000].map(longWait)).toEqual(['none', 'under_1h', '1_24h', '24_48h', '48_72h', '3_7d', 'over_7d']);
  });
});

/** The text of the balanced `{…}` starting at `src[i]`, strings and nesting respected. */
function objectAt(src: string, i: number): string {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (c === "'" || c === '"' || c === '`') { const q = c; for (j++; j < src.length && src[j] !== q; j++) if (src[j] === '\\') j++; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced');
}

/** Top-level `key: value` entries of an object literal; a spread contributes the entries of every object literal inside it. */
function entries(obj: string): { key: string; value: string }[] {
  const inner = obj.slice(1, -1);
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j]!;
    if (c === "'" || c === '"' || c === '`') { const q = c; let k = j + 1; for (; k < inner.length && inner[k] !== q; k++) if (inner[k] === '\\') k++; cur += inner.slice(j, k + 1); j = k; continue; }
    if ('{(['.includes(c)) depth++;
    if ('})]'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.flatMap((raw) => {
    const part = raw.trim();
    if (part.startsWith('...')) {
      const out: { key: string; value: string }[] = [];
      for (let k = part.indexOf('{'); k !== -1; k = part.indexOf('{', k + 1)) { const o = objectAt(part, k); out.push(...entries(o)); k += o.length - 1; }
      return out;
    }
    const colon = part.indexOf(':');
    return [{ key: (colon === -1 ? part : part.slice(0, colon)).trim(), value: colon === -1 ? '' : part.slice(colon + 1).trim() }];
  });
}

/** Every `capture(…, 'Event', {…})` and `ev('Event', {…})` in src/: the call sites the allow-list must cover. */
function callSites(): { file: string; event: string; props: { key: string; value: string }[] }[] {
  const root = join(import.meta.dirname, '../../src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const out: { file: string; event: string; props: { key: string; value: string }[] }[] = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:capture\([^'"()]*(?:\([^()]*\)[^'"()]*)*|ev\()'([A-Z][A-Za-z0-9 ]+)'\s*(,\s*\{)?/g)) {
      const props = m[2] ? entries(objectAt(src, m.index! + m[0].length - 1)) : [];
      out.push({ file: file.slice(root.length + 1), event: m[1]!, props });
    }
  }
  return out;
}

describe('every call site', () => {
  const sites = callSites();
  it('there are call sites, and every one names an event of the table', () => {
    expect(sites.length).toBeGreaterThan(30);
    for (const s of sites) expect(Object.keys(EVENTS), `${s.file}: ${s.event}`).toContain(s.event);
  });

  it('passes only properties the event allows, literal values only from its list, and nothing taken from the request or the account', () => {
    for (const s of sites) {
      const shape = EVENTS[s.event as keyof typeof EVENTS] as Record<string, unknown>;
      for (const { key, value } of s.props) {
        expect(Object.keys(shape), `${s.file}: ${s.event}.${key}`).toContain(key);
        const literal = /^'([^']*)'$/.exec(value);
        if (literal) { expect(shape[key], `${s.file}: ${s.event}.${key}='${literal[1]}'`).toContain(literal[1]); continue; } // a listed literal (e.g. method 'token')
        expect(value, `${s.file}: ${s.event}.${key}`).not.toMatch(/headers|cf-connecting-ip|user-agent|\.email\b|\.domain\b|\.name\b|token|stripe_|cf_account|cf_zone|workspace_name|\.id\b/i);
      }
    }
  });
});

describe('the send', () => {
  it('posts one batch to POSTHOG_HOST/batch/ with the project key, personless and without geolocation, and no header but Content-Type', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }));
    await send(ON, { analyticsId: VISITOR_ID }, [{ event: 'Signup Started', props: { entry: 'checker', method: 'email_code', email: 'x@y.com' } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${POSTHOG_HOST}/batch/`);
    expect(calls[0]!.init.method).toBe('POST');
    expect([...new Headers(calls[0]!.init.headers as HeadersInit).keys()]).toEqual(['content-type']);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ api_key: POSTHOG_KEY, batch: [{ event: 'Signup Started', distinct_id: VISITOR_ID, properties: { entry: 'checker', method: 'email_code', surface: 'app', $process_person_profile: false, $geoip_disable: true } }] });
    expect(Object.keys(body)).toEqual(['api_key', 'batch']);
    expect(JSON.stringify(body)).not.toMatch(/\$ip|x@y\.com/);
    expect(violations(body, new Set([VISITOR_ID]))).toEqual([]);
  });

  it('retries once on a 5xx or a network error, never more, and never on a 4xx; it never throws', async () => {
    vi.useFakeTimers();
    const run = async (answers: (Response | Error)[]) => {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => { const a = answers[Math.min(n++, answers.length - 1)]!; if (a instanceof Error) throw a; return a; }));
      const p = send(ON, { analyticsId: VISITOR_ID }, [{ event: 'Signup Started', props: {} }]);
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 10);
      await p;
      return n;
    };
    expect(await run([new Response('', { status: 503 })])).toBe(2);
    expect(await run([new Error('reset')])).toBe(2);
    expect(await run([new Response('', { status: 503 }), new Response('{}')])).toBe(2);
    expect(await run([new Response('', { status: 400 })])).toBe(1);
    expect(await run([new Response('{}')])).toBe(1);
  });

  it('never delays the request: capture returns at once and hands the send to waitUntil', async () => {
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { release = () => r(new Response('{}')); })));
    const waitUntil = vi.fn();
    const t0 = Date.now();
    capture({ ...ON, DB: createMigratedD1() as unknown as D1Database }, { waitUntil }, { analyticsId: VISITOR_ID }, 'Signed In', { method: 'code' });
    expect(Date.now() - t0).toBeLessThan(50);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await waitUntil.mock.calls[0]![0];
  });

  it('when off, capture does nothing at all (no waitUntil, no fetch)', () => {
    const waitUntil = vi.fn();
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    captureMany({ MODE: 'saas' }, { waitUntil }, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: {} }]);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('batchBody is the documented shape', () => {
    expect(batchBody({ key: POSTHOG_KEY, batchUrl: '' }, VISITOR_ID, [{ event: 'Signed In', props: { method: 'code' } }], Date.UTC(2026, 10, 15, 12, 0, 7, 654))).toEqual({
      api_key: POSTHOG_KEY,
      batch: [{ event: 'Signed In', distinct_id: VISITOR_ID, timestamp: '2026-11-15T12:00:07Z', properties: { method: 'code', surface: 'app', $process_person_profile: false, $geoip_disable: true, $lib: 'ready-set-mail-worker' } }],
    });
  });

  it('timestamps: when the step happened (the call), not when the batch leaves; whole seconds; never backwards inside a batch', async () => {
    const T0 = Date.UTC(2026, 10, 15, 12, 0, 7, 654);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response('{}'); }));
    const waits: Promise<unknown>[] = [];
    const c = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    captureLater(ON, c, async () => {
      vi.setSystemTime(T0 + 9000); // the background reads take a while: the event still says when it happened
      return { subject: { analyticsId: VISITOR_ID }, events: [ev('Code Verified', { purpose: 'signup' }), ev('Workspace Created', { source: 'signup' })] };
    });
    await Promise.all(waits);
    expect(bodies[0].batch.map((e: any) => [e.event, e.timestamp])).toEqual([['Code Verified', '2026-11-15T12:00:07Z'], ['Workspace Created', '2026-11-15T12:00:07Z']]);
    expect(toSecond(T0)).toBe('2026-11-15T12:00:07Z');
    const b = batchBody({ key: POSTHOG_KEY, batchUrl: '' }, VISITOR_ID, [{ event: 'A', props: {}, at: T0 + 2000 }, { event: 'B', props: {}, at: T0 }]);
    expect(b.batch.map((e) => e.timestamp)).toEqual(['2026-11-15T12:00:09Z', '2026-11-15T12:00:09Z']);
  });

  it('the outgoing request carries no X-Forwarded-For, CF-Connecting-IP, Forwarded, X-Real-IP, the visitor\'s User-Agent or cookie', async () => {
    const { world } = await import('./walk');
    const w = world();
    const visitor = { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9', 'x-real-ip': '203.0.113.9', forwarded: 'for=203.0.113.9', 'user-agent': 'VisitorBrowser/1.0', cookie: 'rsm_session=abc', referer: 'https://acme-walk.com/' };
    const s1 = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'hdr@acme-walk.com', password: SECRETS.password }, headers: visitor });
    expect(s1.status).toBe(200);
    const { settle } = await import('./walk');
    await settle();
    expect(w.sent.length).toBeGreaterThan(0);
    for (const r of w.sent) {
      expect(Object.keys(r.headers)).toEqual(['content-type']);
      expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.9|VisitorBrowser|rsm_session/);
    }
  });
});

describe('identity', () => {
  it('a random id per workspace, made once by the Worker; a new workspace adopts only an id the Worker minted', async () => {
    const db = createMigratedD1() as unknown as D1Database;
    (db as any).sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_a', 'A'), ('ws_b', 'B'), ('ws_c', 'C')").run();
    const a = await analyticsIdFor(db, 'ws_a');
    expect(mintedId(a)).toBe(a);
    expect(await analyticsIdFor(db, 'ws_a')).toBe(a);
    expect(a).not.toContain('ws_a');
    expect(await adoptAnalyticsId(db, 'ws_b', VISITOR_ID)).toBe(VISITOR_ID);
    expect(await adoptAnalyticsId(db, 'ws_a', VISITOR_ID)).toBe(a); // already has one: kept
    for (const bad of ['', 'not-a-uuid', VISITOR_ID.toUpperCase(), `${VISITOR_ID} `, 'founder@acme-walk.com', '00000000-0000-0000-0000-000000000000']) expect(mintedId(bad), bad).toBeNull();
    const c = await adoptAnalyticsId(db, 'ws_c', 'acme-walk.com');
    expect(mintedId(c)).toBe(c);
  });

  it('nothing a sign-up sends chooses the id: a `vid` is ignored, and two sign-ups carrying the same one get two different ids', async () => {
    const { world } = await import('./walk');
    const w = world();
    await w.signUp('one@acme-walk.com', { vid: STRAY_VID, src: 'home' });
    await w.signUp('two@acme-walk.com', { vid: STRAY_VID, src: 'home' });
    const a = w.analyticsIdOf(w.workspaceOf('one@acme-walk.com'))!;
    const b = w.analyticsIdOf(w.workspaceOf('two@acme-walk.com'))!;
    expect(mintedId(a)).toBe(a);
    expect(mintedId(b)).toBe(b);
    expect(a).not.toBe(b);
    expect([a, b]).not.toContain(STRAY_VID);
    const { settle } = await import('./walk');
    await settle();
    expect(w.sent.map((r) => r.body).join('')).not.toContain(STRAY_VID);
  });

  it('entry comes from the website link\'s src, from a closed list (anything else other, none cold); from_checker only as a boolean', async () => {
    const { world, settle } = await import('./walk');
    const w = world();
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{ src: 'checker', from_checker: true }, 'checker', true], [{ src: 'pricing' }, 'pricing', false], [{ src: 'tools' }, 'tools', false],
      [{ src: 'errors' }, 'errors', false], [{ src: 'https://evil.example/x' }, 'other', false], [{ src: 'cold' }, 'other', false],
      [{ src: 42, from_checker: 'acme-walk.com' }, 'other', false], [{}, 'cold', false],
    ];
    for (const [i, [link, entry, fromChecker]] of cases.entries()) {
      const email = `src${i}@acme-walk.com`;
      await w.signUp(email, link);
      await settle();
      const id = w.analyticsIdOf(w.workspaceOf(email));
      const mine = w.events().filter((e) => e.distinct_id === id);
      expect(mine.find((e) => e.event === 'Signup Started')?.properties, JSON.stringify(link)).toMatchObject({ method: 'email_code', entry, from_checker: fromChecker });
      expect(mine.find((e) => e.event === 'Code Verified')?.properties).toMatchObject({ entry, from_checker: fromChecker });
      expect(mine.find((e) => e.event === 'Workspace Created')?.properties).toMatchObject({ source: 'signup', method: 'email_code' });
    }
  });
});

describe('waiting on the new sign-up (PR 177)', () => {
  it('the profile event sends only the closed answers and whether "heard about" was filled, never its text', async () => {
    const { signupProfileSaved, signupTag, signupHooks } = await import('../../src/product-analytics/auth');
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response('{}'); }));
    const db = createMigratedD1();
    const env = { ...ON, DB: db as unknown as D1Database };
    const { identifierFor } = await import('../../src/auth/codes');
    const handle = 'h'.repeat(43);
    db.sqlite.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, ?, ?, ?)').run('v1', await identifierFor(handle), JSON.stringify({ p: 'signup', t: 0 }), Math.floor(Date.now() / 1000) + 600);
    const tag = (await signupTag(env, null, { vid: VISITOR_ID } as never))!;
    expect(tag.id).not.toBe(VISITOR_ID);
    const hooks = signupHooks(env, undefined, tag)!;
    await hooks.started(handle);
    const waits: Promise<unknown>[] = [];
    await signupProfileSaved(env, { waitUntil: (p: Promise<unknown>) => waits.push(p) }, handle, { whose_email: 'clients', role: 'agency', heard_about: 'A friend at acme-walk.com told me' });
    await Promise.all(waits);
    const body = JSON.parse(sent.at(-1)!);
    expect(body.batch[0]).toMatchObject({ event: 'Signup Profile Saved', distinct_id: tag.id, properties: { whose_email: 'clients', role: 'agency', heard_about_given: true } });
    expect(sent.at(-1)).not.toMatch(/friend|acme-walk/);
  });
});

/**
 * Whether an ordered PostHog funnel counts this account through `steps`: each step an event (optionally with property values) at or
 * after the previous step's time. Equal times count, as in PostHog's funnel function (ties are taken in step order).
 */
function reaches(events: { event: string; timestamp: string; properties: Record<string, unknown> }[], steps: (string | [string, Record<string, unknown>])[]): string | null {
  let t = '';
  for (const step of steps) {
    const [name, props] = typeof step === 'string' ? [step, {}] : step;
    const hit = events.filter((e) => e.event === name && e.timestamp >= t && Object.entries(props).every(([k, v]) => e.properties[k] === v)).sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
    if (!hit) return `${name}${JSON.stringify(props)} not reached after ${t} in ${events.map((e) => `${e.timestamp.slice(11)} ${e.event}`).join(' > ')}`;
    t = hit.timestamp;
  }
  return null;
}
const SETUP_STARTED = ['Domain Added', 'Cloudflare Connect Started'];
/** The onboarding funnel (scripts/posthog-setup.mjs): the same steps on every path. Setup Started is the action, either event. */
function onboarding(events: Parameters<typeof reaches>[0], until = 'Records Live') {
  const steps = ['Signup Started', 'Workspace Created', 'Dashboard First Viewed', 'RSM Setup Started', 'Ownership Verified', 'Records Live', 'First Report Received'];
  const mapped = events.map((e) => (SETUP_STARTED.includes(e.event) ? [e, { ...e, event: 'RSM Setup Started' }] : [e])).flat();
  return reaches(mapped, steps.slice(0, steps.indexOf(until) + 1));
}

/** The A7 checks on every request a walk made. */
function clean(w: { sent: { url: string; headers: Record<string, string>; body: string }[] }, ids: Set<string>, extra: string[] = []) {
  for (const r of w.sent) {
    expect(r.url).toBe(`${POSTHOG_HOST}/batch/`);
    expect(Object.keys(r.headers)).toEqual(['content-type']);
    expect(violations(JSON.parse(r.body), ids), r.body).toEqual([]);
    const lower = r.body.toLowerCase();
    for (const s of [...SECRETS.emails, ...SECRETS.domains, SECRETS.password, STRAY_VID, 'acme walk', 'cf-acct-walk', ...extra]) expect(lower, s).not.toContain(s.toLowerCase());
  }
}

const pathsOut: Record<string, unknown> = {};
const keep = (name: string, events: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[]) => {
  pathsOut[name] = events.map(({ event, distinct_id, timestamp, properties }) => ({ timestamp, event, distinct_id, properties }));
  if (process.env.ANALYTICS_PATHS_OUT) writeFileSync(process.env.ANALYTICS_PATHS_OUT, JSON.stringify({ source: 'test/product-analytics/analytics.test.ts fixture walks (fakes: Cloudflare, its DoH, Cloudflare OAuth, Stripe, GitHub)', paths: pathsOut }, null, 2));
};

describe('the fixture walk, Cloudflare OAuth path: sign-up → records live → first report → a paid, delivered order', () => {
  it('sends the funnel steps in order under the workspace\'s minted id, and nothing forbidden in any request', async () => {
    const w = await runWalk();
    const names = w.events.map((e) => e.event);
    if (process.env.ANALYTICS_WALK_OUT) writeFileSync(process.env.ANALYTICS_WALK_OUT, JSON.stringify({ source: 'test/product-analytics/analytics.test.ts fixture walk', events: w.events.map(({ event, distinct_id, properties }) => ({ event, distinct_id, properties })) }, null, 2));
    keep('cloudflare_oauth', w.events);

    const id = w.analyticsIds.find((r) => r.workspace_id === w.workspaceId)!.value;
    expect(mintedId(id)).toBe(id);
    expect(id).not.toBe(STRAY_VID);
    const mine = w.events.filter((e) => e.distinct_id === id);
    expect(onboarding(mine, 'First Report Received')).toBeNull();
    expect(reaches(mine, ['Signup Started', 'Signup Code Sent', 'Code Verified', 'Workspace Created'])).toBeNull();
    expect(reaches(mine, ['Cloudflare Connect Started', ['Cloudflare Connect Returned', { result: 'connected' }], 'Ownership Verified', 'Apply Clicked', 'Apply Done', ['Records Live', { path: 'cloudflare' }]])).toBeNull();
    expect(reaches(mine, ['Records Live', 'Fix Offer Viewed', 'Card Setup Started', 'Card Setup Completed', 'Fix Order Created', 'Fix Order Paid', 'Fix Order Delivered'])).toBeNull();
    expect(mine.filter((e) => e.event === 'Signup Code Sent')).toHaveLength(2); // the first code and the one asked for again
    expect(mine.filter((e) => e.event === 'Signup Started')).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(['Invite Sent', 'Invite Accepted', 'Workspace Active', 'Signed In']));

    const ids = new Set(w.analyticsIds.map((r) => r.value));
    for (const e of w.events) expect(ids, e.event).toContain(e.distinct_id);

    expect(mine.find((e) => e.event === 'Signup Started')!.properties).toMatchObject({ method: 'email_code', entry: 'checker', from_checker: true });
    expect(mine.find((e) => e.event === 'Code Verified')!.properties).toMatchObject({ purpose: 'signup', from_checker: true, entry: 'checker', resends: '1', attempts: '1', account_created: true });
    expect(mine.find((e) => e.event === 'Cloudflare Connect Started')!.properties).toMatchObject({ path: 'cloudflare', method: 'oauth' });
    expect(mine.find((e) => e.event === 'Ownership Verified')!.properties).toMatchObject({ path: 'cloudflare', method: 'cloudflare_zone' });
    expect(mine.find((e) => e.event === 'Records Live')!.properties).toMatchObject({ path: 'cloudflare', seen_by: 'setup', method: 'cloudflare_zone', since_apply: 'under_1m', domains_live: '1' });
    expect(mine.find((e) => e.event === 'First Report Received')!.properties).toMatchObject({ path: 'cloudflare' });
    expect(w.events.find((e) => e.event === 'Fix Order Paid')!.properties).toMatchObject({ offer: 'fix_one_domain', price_tier: 'list' });

    // Events of one request keep their causal order, at whole seconds.
    const cv = mine.findIndex((e) => e.event === 'Code Verified');
    expect(mine[cv + 1]?.event).toBe('Workspace Created');
    expect(mine[cv + 1]!.timestamp >= mine[cv]!.timestamp).toBe(true);

    expect(w.sent.length).toBeGreaterThan(10);
    clean(w, ids, [w.workspaceId, w.order.id]);
  }, 60_000);
});

describe('the other paths: a pasted token, records added by hand, a sign-up with GitHub', () => {
  it('pasted token: Connect Started (token) and Returned go together, in order, so both setup funnels count this path', async () => {
    const { runTokenWalk } = await import('./walk');
    const w = await runTokenWalk();
    keep('pasted_token', w.events);
    const mine = w.events.filter((e) => e.distinct_id === w.analyticsId);
    expect(onboarding(mine)).toBeNull();
    expect(reaches(mine, ['Cloudflare Connect Started', ['Cloudflare Connect Returned', { result: 'connected' }], 'Ownership Verified', 'Apply Clicked', 'Apply Done', ['Records Live', { path: 'cloudflare' }]])).toBeNull();
    const batch = w.sent.map((r) => JSON.parse(r.body).batch).find((b: any[]) => b.some((e) => e.event === 'Cloudflare Connect Started'));
    expect(batch.map((e: any) => [e.event, e.properties.method])).toEqual([['Cloudflare Connect Started', 'token'], ['Cloudflare Connect Returned', 'token']]);
    expect(batch[0].timestamp <= batch[1].timestamp).toBe(true);
    expect(mine.find((e) => e.event === 'Signup Started')!.properties).toMatchObject({ entry: 'pricing', from_checker: false });
    expect(mine.find((e) => e.event === 'Domain Added')!.properties).toMatchObject({ path: 'cloudflare', source: 'cloudflare_import' });
    clean(w, new Set([w.analyticsId]));
  }, 60_000);

  it('records added by hand: no Apply at all, and the onboarding and manual funnels still finish; Records Live is seen by the domain page, once', async () => {
    const { runManualWalk } = await import('./walk');
    const { runCronForWorkspaces } = await import('../../src/cron');
    const { ctx } = await import('../auth/helpers');
    const w = await runManualWalk({ cron: async (x) => { await runCronForWorkspaces({ cron: '0 8 * * *' } as ScheduledController, x.env, ctx, { workspaces: [x.workspaceOf(SECRETS.emails[4]!)] }); } });
    keep('manual_records', w.events);
    const mine = w.events.filter((e) => e.distinct_id === w.analyticsId);
    expect(mine.filter((e) => e.event.startsWith('Apply'))).toEqual([]);
    expect(onboarding(mine, 'First Report Received')).toBeNull();
    expect(reaches(mine, [['Domain Added', { path: 'manual' }], ['Ownership Verified', { path: 'manual' }], ['Records Live', { path: 'manual' }]])).toBeNull();
    const live = mine.filter((e) => e.event === 'Records Live');
    expect(live).toHaveLength(1); // the page checked twice, and the daily job read it again
    expect(live[0]!.properties).toMatchObject({ path: 'manual', seen_by: 'domain_page', method: 'txt', since_apply: 'none' });
    expect(mine.find((e) => e.event === 'Ownership Verified')!.properties).toMatchObject({ path: 'manual', method: 'txt' });
    expect(mine.find((e) => e.event === 'First Report Received')!.properties).toMatchObject({ path: 'manual' });
    expect(mine.find((e) => e.event === 'Signup Started')!.properties).toMatchObject({ entry: 'cold', from_checker: false });
    clean(w, new Set([w.analyticsId]));
  }, 60_000);

  it('sign-up with GitHub: Signup Started and Workspace Created (method oauth_github), in order; a later GitHub sign-in is Signed In', async () => {
    const { runOAuthSignup } = await import('./walk');
    const w = await runOAuthSignup();
    keep('oauth_signup', w.events);
    const mine = w.events.filter((e) => e.distinct_id === w.analyticsId);
    expect(mintedId(w.analyticsId)).toBe(w.analyticsId);
    expect(reaches(mine, [['Signup Started', { method: 'oauth_github' }], ['Workspace Created', { source: 'signup', method: 'oauth_github' }], ['Signed In', { method: 'oauth_github' }]])).toBeNull();
    expect(mine.filter((e) => e.event === 'Signup Started')).toHaveLength(1);
    expect(mine.filter((e) => e.event === 'Signed In')).toHaveLength(1);
    expect(mine.map((e) => e.event)).not.toContain('Signup Code Sent');
    clean(w, new Set([w.analyticsId]), ['octo-walk', 'gho_walk', '4242']);
  }, 60_000);
});

describe('never harms what it rides on', () => {
  it('capture, captureMany and captureLater never throw, whatever they are given; the failure is counted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hostileEvents = new Proxy([], { get: () => { throw new Error('boom'); } }) as never;
    const badCtx = { waitUntil: () => { throw new Error('cannot extend'); } };
    expect(() => captureMany(ON, undefined, { analyticsId: VISITOR_ID }, hostileEvents)).not.toThrow();
    expect(() => capture(ON, badCtx, { analyticsId: VISITOR_ID }, 'Signed In', { method: 'code' })).not.toThrow();
    expect(() => captureLater(ON, badCtx, (() => { throw new Error('sync throw'); }) as never)).not.toThrow();
    const env = { MODE: 'saas', get POSTHOG_KEY(): string { throw new Error('getter'); }, POSTHOG_HOST };
    expect(() => capture(env, undefined, { analyticsId: VISITOR_ID }, 'Signed In')).not.toThrow();
    for (const bad of [123, { url: 'x' }, ['phc_x'], null, true]) {
      expect(() => capture({ MODE: 'saas', POSTHOG_KEY: bad, POSTHOG_HOST }, undefined, { analyticsId: VISITOR_ID }, 'Signed In')).not.toThrow();
      expect(() => capture({ MODE: 'saas', POSTHOG_KEY, POSTHOG_HOST: bad }, undefined, { analyticsId: VISITOR_ID }, 'Signed In')).not.toThrow();
      expect(() => capture({ MODE: bad, POSTHOG_KEY, POSTHOG_HOST }, undefined, { analyticsId: VISITOR_ID }, 'Signed In')).not.toThrow();
    }
    await new Promise((r) => setTimeout(r, 0));
    const drops = warn.mock.calls.map((c) => String(c[0]));
    expect(drops).toEqual(expect.arrayContaining(['[product-analytics] dropped: capture', '[product-analytics] dropped: later']));
    expect(drops.every((d) => /^\[product-analytics\] dropped: [a-z]+$/.test(d))).toBe(true); // the stage only, never the error
  });

  it('malformed POSTHOG_KEY / POSTHOG_HOST: requests, the Stripe webhook, report intake and the cron all work, and nothing is sent', async () => {
    for (const bad of [{ POSTHOG_KEY: 123 }, { POSTHOG_HOST: { url: 'https://us.i.posthog.com' } }, { POSTHOG_HOST: 'https://app.readysetmail.com/ingest' }]) {
      const w = await runWalk(bad); // request routes, the fake Stripe's signed webhook, hosted report intake
      expect(w.sent, JSON.stringify(bad)).toEqual([]);
      expect(w.rows('SELECT status FROM billing_orders')).toEqual([{ status: 'done' }]);
      expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBeGreaterThan(0);
      const { runCronForWorkspaces } = await import('../../src/cron');
      const { ctx } = await import('../auth/helpers');
      for (const cron of ['0 8 * * *', '0 11 * * *']) await expect(runCronForWorkspaces({ cron } as ScheduledController, w.env, ctx, { workspaces: [w.workspaceId] })).resolves.toBeUndefined();
      expect(w.sent).toEqual([]);
      expect(w.rows("SELECT COUNT(*) AS n FROM settings WHERE key = 'analytics_id' OR key LIKE 'analytics:%'")[0].n).toBe(0);
    }
  }, 120_000);

  it('with any one of MODE=saas, POSTHOG_KEY or POSTHOG_HOST missing, a walk makes zero requests to PostHog', async () => {
    const { world, settle } = await import('./walk');
    for (const missing of [{ POSTHOG_KEY: undefined }, { POSTHOG_HOST: undefined }]) {
      const w = world(missing);
      const token = await w.signUp('miss@acme-walk.com', { src: 'home' });
      await w.api(token, 'POST', '/api/domains', { domain: 'acme-walk.com' });
      await settle();
      expect(w.sent, JSON.stringify(Object.keys(missing))).toEqual([]);
    }
    // MODE: a self-hosted instance with both PostHog settings (see "off by default" for its setup and sign-up).
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    capture({ POSTHOG_KEY, POSTHOG_HOST }, undefined, { analyticsId: VISITOR_ID }, 'Signed In');
    await send({ MODE: 'selfhost', POSTHOG_KEY, POSTHOG_HOST }, { analyticsId: VISITOR_ID }, [{ event: 'Signed In', props: {} }]);
    expect(f).not.toHaveBeenCalled();
  }, 60_000);
});

describe('cost', () => {
  it('the daily job passes the row it has: a domain not live costs no query; a live one already counted costs exactly one', async () => {
    const { runManualWalk, settle } = await import('./walk');
    const { dnsChecked } = await import('../../src/product-analytics/steps');
    const { loadTenant } = await import('../../src/tenancy/load');
    const { ctx } = await import('../auth/helpers');
    const w = await runManualWalk();
    const tenant = await loadTenant(w.env, { workspaceId: w.workspaceId });
    const row = (await tenant.scope.domains.getById(w.domainId))!;
    const prepare = vi.spyOn(w.env.DB as any, 'prepare');
    dnsChecked(tenant, ctx, row, { p: 'none', rua: ['someone-else@example.net'] }, 'daily');
    dnsChecked(tenant, ctx, { ...row, rua_address: '' }, { p: 'none', rua: [] }, 'daily');
    await settle();
    expect(prepare).not.toHaveBeenCalled();
    dnsChecked(tenant, ctx, row, { p: 'none', rua: [row.rua_address!] }, 'daily');
    await settle();
    expect(prepare).toHaveBeenCalledTimes(1); // the marker, already there: no event, no other read
    expect(w.sent.flatMap((r) => JSON.parse(r.body).batch).filter((e: any) => e.event === 'Records Live')).toHaveLength(1);
  }, 60_000);
});

describe('the allow-list after the changes', () => {
  it('still drops every property and value not listed, for every event of every walk', async () => {
    for (const [event, shape] of Object.entries(EVENTS)) {
      const junk = { ...Object.fromEntries(Object.keys(shape).map((k) => [k, 'not-a-listed-value'])), vid: VISITOR_ID, visitor_id: 'passed', src: 'checker', domain: 'acme-walk.com', $ip: '203.0.113.9' };
      expect(allowed(event, junk), event).toEqual({});
    }
    expect(Object.values(EVENTS).flatMap((s) => Object.keys(s))).not.toEqual(expect.arrayContaining(['visitor_id']));
  });
});
