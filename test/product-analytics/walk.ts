// The fixture walk of docs/analytics.md, shared by the forbidden-property test and the event-sequence test: a hosted instance with
// PostHog configured at a fake endpoint, walked with the repo's fakes (Cloudflare and its DNS-over-HTTPS, the mock Cloudflare OAuth
// server, the fake Stripe) from a sign-up that arrives with a website visitor id, through records live and the first report, to a
// paid and delivered order. Every request the Worker makes to PostHog is kept, as sent.
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { forWorkspace } from '@ready-set-mail/db';
import { handleApi } from '../../src/api/router';
import { handleHostedEmail } from '../../src/hosted/intake';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { BASE, call, ctx, enterCode, inviteAndAccept, lastCodeFor, makeEnv, pendingCookieOf } from '../auth/helpers';
import { FakeCloudflare } from '../helpers/cf-fake';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { AUTH, MockAuthServer } from '../connections/mock-oauth';
import { KEY } from '../connections/world';
import { createFakeStripe } from '../../e2e/support/fake-stripe.mjs';

export const POSTHOG_HOST = 'https://ph.fake.test';
export const POSTHOG_KEY = 'phc_testprojectkey0123456789';
export const VISITOR_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
export const WHSEC = 'whsec_walksecret0123456789';

/** Everything the walk typed or was given that must never reach PostHog. */
export const SECRETS = {
  emails: ['founder@acme-walk.com', 'mate@acme-walk.com', 'operator@example.com'],
  domains: ['acme-walk.com', 'side-walk.org'],
  password: 'correct-horse-battery',
};

export interface SentRequest { url: string; method: string; headers: Record<string, string>; body: string }

/** Wait until every background job (waitUntil) the walk started has settled, including the ones they start. */
export async function settle(): Promise<void> {
  const calls = (ctx.waitUntil as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  for (let seen = -1; seen !== calls.length;) {
    seen = calls.length;
    await Promise.allSettled(calls.map((c) => c[0] as Promise<unknown>));
    await new Promise((r) => setTimeout(r, 0));
  }
}

const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);

export async function runWalk(extraEnv: Record<string, unknown> = {}) {
  for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  const sent: SentRequest[] = [];
  const db = createMigratedD1();
  const mail = { send: vi.fn(async () => {}) };
  const INTAKE = 'rua.intake.example.net';
  const env = makeEnv(db, {
    MODE: 'saas', SAAS_ENABLED: '1', TOKEN_ENCRYPTION_KEY: `k1:${KEY}`, SEND_EMAIL: mail, ...AUTH,
    INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar',
    STRIPE_SECRET_KEY: 'rk_test_walkkey0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, OWNER_EMAIL: 'operator@example.com',
    POSTHOG_KEY, POSTHOG_HOST, ...extraEnv,
  }) as any;

  const cf = new FakeCloudflare({
    'acme-walk.com': { id: zid('acme-walk.com'), cfAccountId: 'cf-acct-walk', cfAccountName: 'Acme Walk Ltd' },
    'side-walk.org': { id: zid('side-walk.org'), cfAccountId: 'cf-acct-walk', cfAccountName: 'Acme Walk Ltd' },
  });
  cf.accounts = [{ id: 'cf-acct-walk', name: 'Acme Walk Ltd' }];
  cf.validTokens = new Set();
  const auth = new MockAuthServer();
  auth.onIssue = (access) => cf.validTokens!.add(access);
  const stripe = createFakeStripe({ webhookSecret: WHSEC });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(POSTHOG_HOST)) {
      sent.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined).entries()), body: String(init?.body ?? '') });
      return new Response('{"status":"Ok"}', { status: 200 });
    }
    if (/^https:\/\/api\.stripe\.com\//.test(url)) return stripe.fetch(input, init);
    return (await auth.handle(input, init)) ?? cf.fetch(input, init);
  });
  stripe.setWebhookTarget(async (r: Request) => handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: r.headers, body: await r.text() }), env as never, ctx));
  const api = (token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(env, method, path, { key: token, body, headers });
  const json = async (r: Response) => (await r.json()) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

  // 1. Sign-up from the website's checker, with its visitor id; a second code is asked for; the newest code is typed.
  const [founder, mate] = SECRETS.emails;
  const s1 = await call(env, 'POST', '/api/auth/signup', { body: { email: founder, password: SECRETS.password, vid: VISITOR_ID, entry: 'checker' } });
  const s2 = await call(env, 'POST', '/api/auth/signup', { body: { email: founder, password: SECRETS.password, vid: VISITOR_ID, entry: 'checker' }, headers: { cookie: pendingCookieOf(s1) } });
  const done = await enterCode(env, pendingCookieOf(s2), await lastCodeFor(env, founder!));
  if (done.status !== 200) throw new Error(`code ${done.status} ${await done.text()}`);
  const token = (await json(done)).token as string;
  const workspaceId = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', founder)[0].workspace_id as string;
  await api(token, 'GET', '/api/me');

  // 2. A teammate is invited and joins.
  await inviteAndAccept(env, token, mate!, 'member');

  // 3. A domain typed by hand (a pending claim), then Cloudflare connected by OAuth and its zones imported (the claim is proven by the zone).
  const [domain] = SECRETS.domains;
  await api(token, 'POST', '/api/domains', { domain });
  const started = await api(token, 'POST', '/api/cloudflare/oauth/start', { return_to: '/setup' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
  const back = new URL(auth.authorize((await json(started)).authorize_url));
  const cb = await api(token, 'GET', back.pathname + back.search, undefined, { cookie });
  const connectionId = new URL(cb.headers.get('location')!, 'https://x').searchParams.get('cf_connection')!;
  await api(token, 'POST', `/api/cloudflare/connections/${connectionId}/import`, {});
  const domainId = rows('SELECT id FROM domains WHERE workspace_id = ? AND domain = ?', workspaceId, domain)[0].id as number;

  // 4. The plan's DMARC step applied through Cloudflare (it connects the reports), then public DNS shows the record: records live.
  const plan = await json(await api(token, 'POST', '/api/onboarding/dns-plan', { domain_ids: [domainId] }));
  await api(token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [domainId], step: 'dmarc', plan_id: plan.plan_id });
  const written = cf.records.get(zid(domain!))?.find((r) => r.name === `_dmarc.${domain}`)?.content;
  if (!written) throw new Error('no DMARC record written');
  cf.doh[`_dmarc.${domain}`] = [written];
  cf.doh[domain!] = ['v=spf1 include:_spf.google.com ~all'];
  await api(token, 'GET', `/api/domains/${domainId}/onboarding-status`);
  await settle();

  // 5. The first aggregate report arrives (at a token address of the domain).
  const intakeToken = generateToken();
  await forWorkspace(db as unknown as D1Database, workspaceId).intake.set(domainId, await hashToken(intakeToken), Math.floor(Date.now() / 1000));
  await handleHostedEmail(fakeMessage(`rua+${intakeToken}@${INTAKE}`, gzipReportMime(dmarcXml(domain!, 'walk-1')), { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } }), env, ctx);

  // 6. The fix is bought: the offer, a card, the order, paid by the fake Stripe's signed webhook, then delivered by the operator.
  const h = { 'x-workspace-id': workspaceId };
  await api(token, 'GET', `/api/billing/domains/${domainId}`, undefined, h);
  const card = await json(await api(token, 'POST', '/api/billing/card-session', { return_path: '/settings' }, h));
  const backFromStripe = stripe.completeCheckout(card.url.split('/pay/')[1], { card: 'ok' });
  await call(env, 'GET', backFromStripe.replace('https://stripe.fake', '').replace(/^https?:\/\/[^/]+/, ''), { key: token, headers: h });
  const bought = await json(await api(token, 'POST', '/api/billing/orders', { domain_id: domainId, offer: 'fix-one-domain', expected_amount: 14900, expected_currency: 'usd' }, h));
  await stripe.flush();
  await settle();
  const opRes = await call(env, 'POST', '/api/auth/signup', { body: { email: SECRETS.emails[2], password: SECRETS.password } });
  const opDone = await enterCode(env, pendingCookieOf(opRes), await lastCodeFor(env, SECRETS.emails[2]!));
  const operator = (await json(opDone)).token as string;
  for (const step of ['started', 'done']) await api(operator, 'POST', `/api/operator/orders/${bought.order.id}/${step}`);

  // 7. The founder comes back: password, then the emailed code.
  const login = await call(env, 'POST', '/api/auth/login', { body: { email: founder, password: SECRETS.password } });
  await enterCode(env, pendingCookieOf(login), await lastCodeFor(env, founder!));
  await settle();

  const analyticsIds = rows("SELECT workspace_id, value FROM settings WHERE key = 'analytics_id'") as { workspace_id: string; value: string }[];
  const events = sent.flatMap((r) => (JSON.parse(r.body) as { batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] }).batch);
  return { env, db, sent, events, workspaceId, domainId, analyticsIds, rows, order: bought.order as { id: string } };
}
