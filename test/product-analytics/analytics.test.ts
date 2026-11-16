// Product analytics (docs/analytics.md): off by default, the allow-list, the send itself, and the forbidden-property checks of
// ticket A7: over every event and value the code can send, over every call site in src/, and over a full fixture walk.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { EVENTS, allowed, countBucket, codeWait, longWait, shortWait, triesBucket, resendsBucket, issuesBucket } from '../../src/product-analytics/events';
import { analyticsConfig, batchBody, capture, captureMany, send, RETRY_DELAY_MS } from '../../src/product-analytics/capture';
import { adoptAnalyticsId, analyticsIdFor, visitorId } from '../../src/product-analytics/identity';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { POSTHOG_HOST, POSTHOG_KEY, SECRETS, VISITOR_ID, runWalk } from './walk';

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
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.timestamp ?? '')) found.push(`timestamp ${e.timestamp}`);
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
    expect(analyticsConfig(ON)).toEqual({ key: POSTHOG_KEY, batchUrl: `${POSTHOG_HOST}/batch/` });
    expect(analyticsConfig({ ...ON, POSTHOG_HOST: 'https://us.i.posthog.com/' })?.batchUrl).toBe('https://us.i.posthog.com/batch/');
  });

  it('refuses a key that is not a project key and a host that is not https (a local fake on 127.0.0.1 or localhost aside)', () => {
    for (const key of ['phx_personalkey0123456789', 'sk_live_x', 'phc_', ' ']) expect(analyticsConfig({ ...ON, POSTHOG_KEY: key }), key).toBeNull();
    for (const host of ['http://us.i.posthog.com', 'ftp://x.test', 'https://user:pw@us.i.posthog.com', 'https://us.i.posthog.com/?a=1', 'not a url']) expect(analyticsConfig({ ...ON, POSTHOG_HOST: host }), host).toBeNull();
    expect(analyticsConfig({ ...ON, POSTHOG_HOST: 'http://127.0.0.1:9999' })?.batchUrl).toBe('http://127.0.0.1:9999/batch/');
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
    expect(allowed('Signup Started', { entry: 'checker', visitor_id: 'passed', email: 'a@b.com', extra: 1 })).toEqual({ entry: 'checker', visitor_id: 'passed' });
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
        if (literal) expect(shape[key], `${s.file}: ${s.event}.${key}='${literal[1]}'`).toContain(literal[1]);
        expect(value, `${s.file}: ${s.event}.${key}`).not.toMatch(/headers|cf-connecting-ip|user-agent|\.email\b|\.domain\b|\.name\b|token|stripe_|cf_account|cf_zone|workspace_name|\.id\b/i);
      }
    }
  });
});

describe('the send', () => {
  it('posts one batch to POSTHOG_HOST/batch/ with the project key, personless and without geolocation, and no header but Content-Type', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }));
    await send(ON, { analyticsId: VISITOR_ID }, [{ event: 'Signup Started', props: { entry: 'checker', visitor_id: 'passed', email: 'x@y.com' } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${POSTHOG_HOST}/batch/`);
    expect(calls[0]!.init.method).toBe('POST');
    expect([...new Headers(calls[0]!.init.headers as HeadersInit).keys()]).toEqual(['content-type']);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ api_key: POSTHOG_KEY, batch: [{ event: 'Signup Started', distinct_id: VISITOR_ID, properties: { entry: 'checker', visitor_id: 'passed', surface: 'app', $process_person_profile: false, $geoip_disable: true } }] });
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
    expect(batchBody({ key: POSTHOG_KEY, batchUrl: '' }, VISITOR_ID, [{ event: 'Signed In', props: { method: 'code' } }], Date.UTC(2026, 10, 15))).toEqual({
      api_key: POSTHOG_KEY,
      batch: [{ event: 'Signed In', distinct_id: VISITOR_ID, timestamp: '2026-11-15T00:00:00.000Z', properties: { method: 'code', surface: 'app', $process_person_profile: false, $geoip_disable: true, $lib: 'ready-set-mail-worker' } }],
    });
  });
});

describe('identity', () => {
  it('a random id per workspace, made once; a visitor id is accepted only as a canonical UUID, and only before the workspace has one', async () => {
    const db = createMigratedD1() as unknown as D1Database;
    (db as any).sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_a', 'A'), ('ws_b', 'B'), ('ws_c', 'C')").run();
    const a = await analyticsIdFor(db, 'ws_a');
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await analyticsIdFor(db, 'ws_a')).toBe(a);
    expect(a).not.toContain('ws_a');
    expect(await adoptAnalyticsId(db, 'ws_b', VISITOR_ID)).toBe(VISITOR_ID);
    expect(await adoptAnalyticsId(db, 'ws_a', VISITOR_ID)).toBe(a); // already has one: kept
    for (const bad of ['', 'not-a-uuid', VISITOR_ID.toUpperCase(), `${VISITOR_ID} `, 'founder@acme-walk.com', '00000000-0000-0000-0000-000000000000']) expect(visitorId(bad), bad).toBeNull();
    const c = await adoptAnalyticsId(db, 'ws_c', 'acme-walk.com');
    expect(visitorId(c)).toBe(c);
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
    const hooks = signupHooks(env, undefined, await signupTag(env, null, { vid: VISITOR_ID }))!;
    await hooks.started(handle);
    const waits: Promise<unknown>[] = [];
    await signupProfileSaved(env, { waitUntil: (p: Promise<unknown>) => waits.push(p) }, handle, { whose_email: 'clients', role: 'agency', heard_about: 'A friend at acme-walk.com told me' });
    await Promise.all(waits);
    const body = JSON.parse(sent.at(-1)!);
    expect(body.batch[0]).toMatchObject({ event: 'Signup Profile Saved', distinct_id: VISITOR_ID, properties: { whose_email: 'clients', role: 'agency', heard_about_given: true } });
    expect(sent.at(-1)).not.toMatch(/friend|acme-walk/);
  });
});

describe('the fixture walk: sign-up → records live → first report → a paid, delivered order', () => {
  it('sends the funnel steps in order, under the visitor id, and nothing forbidden in any request', async () => {
    const w = await runWalk();
    const names = w.events.map((e) => e.event);
    if (process.env.ANALYTICS_WALK_OUT) writeFileSync(process.env.ANALYTICS_WALK_OUT, JSON.stringify({ source: 'test/product-analytics/analytics.test.ts fixture walk', events: w.events.map(({ event, distinct_id, properties }) => ({ event, distinct_id, properties })) }, null, 2));

    // The onboarding funnel, in order, for the founder's workspace.
    const mine = w.events.filter((e) => e.distinct_id === VISITOR_ID).map((e) => e.event);
    const order = ['Signup Started', 'Signup Code Sent', 'Code Verified', 'Workspace Created', 'Dashboard First Viewed', 'Domain Added', 'Cloudflare Connect Started', 'Cloudflare Connect Returned', 'Ownership Verified', 'Apply Clicked', 'Apply Done', 'Records Live', 'First Report Received', 'Fix Offer Viewed', 'Card Setup Started', 'Card Setup Completed', 'Fix Order Created', 'Fix Order Paid', 'Fix Order Delivered'];
    let at = -1;
    for (const step of order) {
      const next = mine.indexOf(step, at + 1);
      expect(next, `${step} after ${order[order.indexOf(step) - 1]} in ${mine.join(' > ')}`).toBeGreaterThan(at);
      at = next;
    }
    expect(mine.filter((e) => e === 'Signup Code Sent')).toHaveLength(2); // the first code and the one asked for again
    expect(names).toEqual(expect.arrayContaining(['Invite Sent', 'Invite Accepted', 'Workspace Active', 'Signed In']));

    // The founder's workspace adopted the visitor id; every distinct id is a workspace's analytics id, and nothing else.
    expect(w.analyticsIds.find((r) => r.workspace_id === w.workspaceId)?.value).toBe(VISITOR_ID);
    const ids = new Set(w.analyticsIds.map((r) => r.value));
    for (const e of w.events) expect(ids, e.event).toContain(e.distinct_id);

    const codeVerified = w.events.find((e) => e.event === 'Code Verified' && e.distinct_id === VISITOR_ID)!;
    expect(codeVerified.properties).toMatchObject({ purpose: 'signup', from_checker: true, entry: 'checker', resends: '1', attempts: '1', account_created: true });
    expect(w.events.find((e) => e.event === 'Records Live')!.properties).toMatchObject({ method: 'cloudflare_zone', since_apply: 'under_1m', domains_live: '1' });
    expect(w.events.find((e) => e.event === 'Fix Order Paid')!.properties).toMatchObject({ offer: 'fix_one_domain', price_tier: 'list' });

    // A7: no request carries anything forbidden, or any id other than the analytics ids; the only header is Content-Type.
    expect(w.sent.length).toBeGreaterThan(10);
    for (const r of w.sent) {
      expect(r.url).toBe(`${POSTHOG_HOST}/batch/`);
      expect(Object.keys(r.headers)).toEqual(['content-type']);
      expect(violations(JSON.parse(r.body), ids), r.body).toEqual([]);
      const lower = r.body.toLowerCase();
      for (const s of [...SECRETS.emails, ...SECRETS.domains, SECRETS.password, w.workspaceId, w.order.id, 'acme walk', 'cf-acct-walk']) expect(lower, s).not.toContain(s.toLowerCase());
    }
  }, 60_000);
});
