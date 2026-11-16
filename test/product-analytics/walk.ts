// The fixture walks of docs/analytics.md, shared by the analytics tests: a hosted instance with PostHog configured (the fetch to it is
// intercepted, nothing leaves the process), walked with the repo's fakes (Cloudflare and its DNS-over-HTTPS, the mock Cloudflare OAuth
// server, the fake Stripe, a fake GitHub for OAuth sign-up). One walk per path:
//   runWalk         — email-code sign-up from the website's checker, Cloudflare by OAuth, Apply, records live, first report, a paid fix
//   runTokenWalk    — email-code sign-up, Cloudflare by a pasted token, import, Apply, records live
//   runManualWalk   — email-code sign-up, a domain typed, proven by TXT, records added by hand, seen live on the domain page, first report
//   runOAuthSignup  — sign-up with GitHub, then a later GitHub sign-in
// Every request the Worker makes to PostHog is kept, as sent.
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

export const POSTHOG_HOST = 'https://us.i.posthog.com';
export const POSTHOG_KEY = 'phc_testprojectkey0123456789';
/** A well-formed UUID a link might carry as `vid`: it must never become anyone's analytics id. */
export const STRAY_VID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
export const WHSEC = 'whsec_walksecret0123456789';
const INTAKE = 'rua.intake.example.net';
const GITHUB = { GITHUB_CLIENT_ID: 'gh-walk-id', GITHUB_CLIENT_SECRET: 'gh-walk-secret' };

/** Everything the walks typed or were given that must never reach PostHog. */
export const SECRETS = {
  emails: ['founder@acme-walk.com', 'mate@acme-walk.com', 'operator@example.com', 'tok@token-walk.io', 'hand@plain-walk.net', 'octo@gh-walk.dev'],
  domains: ['acme-walk.com', 'side-walk.org', 'token-walk.io', 'plain-walk.net', 'gh-walk.dev'],
  password: 'correct-horse-battery',
};

export interface SentRequest { url: string; method: string; headers: Record<string, string>; body: string }
export interface SentEvent { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }

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

/** A hosted instance with every fake wired; `extraEnv` can break or remove the PostHog settings. */
export function world(extraEnv: Record<string, unknown> = {}) {
  for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  const sent: SentRequest[] = [];
  const db = createMigratedD1();
  const mail = { send: vi.fn(async () => {}) };
  const env = makeEnv(db, {
    MODE: 'saas', SAAS_ENABLED: '1', TOKEN_ENCRYPTION_KEY: `k1:${KEY}`, SEND_EMAIL: mail, ...AUTH, ...GITHUB,
    INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar',
    STRIPE_SECRET_KEY: 'rk_test_walkkey0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, OWNER_EMAIL: 'operator@example.com',
    POSTHOG_KEY, POSTHOG_HOST, ...extraEnv,
  }) as any;

  const zone = (name: string) => ({ id: zid(name), cfAccountId: 'cf-acct-walk', cfAccountName: 'Acme Walk Ltd' });
  const cf = new FakeCloudflare({ 'acme-walk.com': zone('acme-walk.com'), 'side-walk.org': zone('side-walk.org'), 'token-walk.io': zone('token-walk.io') });
  cf.accounts = [{ id: 'cf-acct-walk', name: 'Acme Walk Ltd' }];
  cf.validTokens = new Set(['walk-pasted-token-0000000000000000']);
  const auth = new MockAuthServer();
  auth.onIssue = (access) => cf.validTokens!.add(access);
  const stripe = createFakeStripe({ webhookSecret: WHSEC });
  const github = { email: SECRETS.emails[5]!, id: 4242 };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://us.i.posthog.com/') || url.startsWith('https://eu.i.posthog.com/')) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit | undefined);
      sent.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(headers.entries()), body: String(init?.body ?? '') });
      return new Response('{"status":"Ok"}', { status: 200 });
    }
    if (/^https:\/\/api\.stripe\.com\//.test(url)) return stripe.fetch(input, init);
    // A fake GitHub for "Sign up with GitHub": the token exchange and the profile with a verified email.
    if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json({ access_token: 'gho_walk', token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id: github.id, login: 'octo-walk', name: 'Octo Walk', email: github.email, avatar_url: '' });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: github.email, primary: true, verified: true, visibility: 'public' }]);
    return (await auth.handle(input, init)) ?? cf.fetch(input, init);
  });
  stripe.setWebhookTarget(async (r: Request) => handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: r.headers, body: await r.text() }), env as never, ctx));
  const api = (token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(env, method, path, { key: token, body, headers });
  const json = async (r: Response) => (await r.json()) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const workspaceOf = (email: string) => rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0]?.workspace_id as string;
  const analyticsIdOf = (workspaceId: string) => rows("SELECT value FROM settings WHERE workspace_id = ? AND key = 'analytics_id'", workspaceId)[0]?.value as string | undefined;

  /** Email-code sign-up with what the website's link sent (`src`, `from_checker`, and a stray `vid` that must be ignored). */
  async function signUp(email: string, link: Record<string, unknown> = {}, resend = false): Promise<string> {
    const body = { email, password: SECRETS.password, ...link };
    const s1 = await call(env, 'POST', '/api/auth/signup', { body });
    const s = resend ? await call(env, 'POST', '/api/auth/signup', { body, headers: { cookie: pendingCookieOf(s1) } }) : s1;
    const done = await enterCode(env, pendingCookieOf(s), await lastCodeFor(env, email));
    if (done.status !== 200) throw new Error(`code ${done.status} ${await done.text()}`);
    const token = (await json(done)).token as string;
    await api(token, 'GET', '/api/me');
    return token;
  }

  /** "Continue with GitHub": the social start, the provider's redirect back to the callback; returns the callback's response. */
  async function github_(): Promise<Response> {
    const start = await call(env, 'POST', '/api/auth/sign-in/social', { body: { provider: 'github', callbackURL: '/' }, headers: { origin: BASE } });
    if (!start.ok) throw new Error(`social ${start.status} ${await start.text()}`);
    const url = new URL(((await start.json()) as { url: string }).url);
    const cookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return call(env, 'GET', `/api/auth/callback/github?code=walk-code&state=${encodeURIComponent(url.searchParams.get('state')!)}`, { headers: { cookie } });
  }

  async function firstReport(workspaceId: string, domainId: number, domain: string, n: string) {
    const intakeToken = generateToken();
    await forWorkspace(db as unknown as D1Database, workspaceId).intake.set(domainId, await hashToken(intakeToken), Math.floor(Date.now() / 1000));
    await handleHostedEmail(fakeMessage(`rua+${intakeToken}@${INTAKE}`, gzipReportMime(dmarcXml(domain, n)), { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } }), env, ctx);
  }

  const events = (): SentEvent[] => sent.flatMap((r) => (JSON.parse(r.body) as { batch: SentEvent[] }).batch);
  return { env, db, sent, events, cf, auth, stripe, api, json, rows, signUp, github: github_, firstReport, workspaceOf, analyticsIdOf, github_profile: github };
}

/** The Cloudflare OAuth path, from a sign-up that came from the website's checker to a paid and delivered fix. */
export async function runWalk(extraEnv: Record<string, unknown> = {}) {
  const w = world(extraEnv);
  const { api, json, rows, cf } = w;
  const [founder, mate] = SECRETS.emails;

  // 1. Sign-up from the website's checker link (src=checker, its domain carried over), with a stray vid; a second code; the newest typed.
  const token = await w.signUp(founder!, { src: 'checker', from_checker: true, vid: STRAY_VID }, true);
  const workspaceId = w.workspaceOf(founder!);

  // 2. A teammate is invited and joins.
  await inviteAndAccept(w.env, token, mate!, 'member');

  // 3. A domain typed by hand (a pending claim), then Cloudflare connected by OAuth and its zones imported (the claim is proven by the zone).
  const [domain] = SECRETS.domains;
  await api(token, 'POST', '/api/domains', { domain });
  const started = await api(token, 'POST', '/api/cloudflare/oauth/start', { return_to: '/setup' });
  const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
  const back = new URL(w.auth.authorize((await json(started)).authorize_url));
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
  await w.firstReport(workspaceId, domainId, domain!, 'walk-1');

  // 6. The fix is bought: the offer, a card, the order, paid by the fake Stripe's signed webhook, then delivered by the operator.
  const h = { 'x-workspace-id': workspaceId };
  await api(token, 'GET', `/api/billing/domains/${domainId}`, undefined, h);
  const card = await json(await api(token, 'POST', '/api/billing/card-session', { return_path: '/settings' }, h));
  const backFromStripe = w.stripe.completeCheckout(card.url.split('/pay/')[1], { card: 'ok' });
  await call(w.env, 'GET', backFromStripe.replace('https://stripe.fake', '').replace(/^https?:\/\/[^/]+/, ''), { key: token, headers: h });
  const bought = await json(await api(token, 'POST', '/api/billing/orders', { domain_id: domainId, offer: 'fix-one-domain', expected_amount: 14900, expected_currency: 'usd' }, h));
  await w.stripe.flush();
  await settle();
  const opRes = await call(w.env, 'POST', '/api/auth/signup', { body: { email: SECRETS.emails[2], password: SECRETS.password } });
  const opDone = await enterCode(w.env, pendingCookieOf(opRes), await lastCodeFor(w.env, SECRETS.emails[2]!));
  const operator = (await json(opDone)).token as string;
  for (const step of ['started', 'done']) await api(operator, 'POST', `/api/operator/orders/${bought.order.id}/${step}`);

  // 7. The founder comes back: password, then the emailed code.
  const login = await call(w.env, 'POST', '/api/auth/login', { body: { email: founder, password: SECRETS.password } });
  await enterCode(w.env, pendingCookieOf(login), await lastCodeFor(w.env, founder!));
  await settle();

  const analyticsIds = rows("SELECT workspace_id, value FROM settings WHERE key = 'analytics_id'") as { workspace_id: string; value: string }[];
  return { ...w, events: w.events(), workspaceId, domainId, analyticsIds, order: bought.order as { id: string } };
}

/** The pasted-token path: sign-up (from the pricing page), a Cloudflare token, its zone imported, Apply, records live. */
export async function runTokenWalk() {
  const w = world();
  const email = SECRETS.emails[3]!;
  const domain = 'token-walk.io';
  const token = await w.signUp(email, { src: 'pricing' });
  const workspaceId = w.workspaceOf(email);
  const c = await w.api(token, 'POST', '/api/cloudflare/connections', { token: 'walk-pasted-token-0000000000000000' });
  if (c.status !== 201) throw new Error(`token connect ${c.status} ${await c.text()}`);
  const id = (await w.json(c)).connection.id;
  await w.api(token, 'POST', `/api/cloudflare/connections/${id}/import`, {});
  const domainId = w.rows('SELECT id FROM domains WHERE workspace_id = ? AND domain = ?', workspaceId, domain)[0].id as number;
  const plan = await w.json(await w.api(token, 'POST', '/api/onboarding/dns-plan', { domain_ids: [domainId] }));
  await w.api(token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [domainId], step: 'dmarc', plan_id: plan.plan_id });
  const written = w.cf.records.get(zid(domain))?.find((r) => r.name === `_dmarc.${domain}`)?.content;
  if (!written) throw new Error('no DMARC record written');
  w.cf.doh[`_dmarc.${domain}`] = [written];
  w.cf.doh[domain] = ['v=spf1 -all'];
  await w.api(token, 'POST', '/api/onboarding/first-check', { domain_ids: [domainId] });
  await settle();
  return { ...w, events: w.events(), workspaceId, domainId, analyticsId: w.analyticsIdOf(workspaceId)! };
}

/**
 * The manual path: sign-up with no link (cold), a domain typed, proven by its TXT record, reports connected, the DMARC record added by
 * hand at its DNS host, seen live by the domain page's DNS check; the daily job later reads it again; the first report arrives.
 */
export async function runManualWalk(opts: { cron?: (w: ReturnType<typeof world>) => Promise<void> } = {}) {
  const w = world();
  const email = SECRETS.emails[4]!;
  const domain = 'plain-walk.net';
  const token = await w.signUp(email);
  const workspaceId = w.workspaceOf(email);
  const added = await w.json(await w.api(token, 'POST', '/api/domains', { domain }));
  if (!added.claim) throw new Error(`expected a pending claim: ${JSON.stringify(added).slice(0, 200)}`);
  w.cf.doh[added.claim.txt_name] = [added.claim.txt_value];
  const verified = await w.api(token, 'POST', `/api/domains/claims/${added.claim.id}/verify`);
  if (!verified.ok) throw new Error(`verify ${verified.status} ${await verified.text()}`);
  const domainId = w.rows('SELECT id FROM domains WHERE workspace_id = ? AND domain = ?', workspaceId, domain)[0]?.id as number;
  if (!domainId) throw new Error('domain not verified');
  const connected = await w.api(token, 'POST', `/api/domains/${domainId}/report-address`);
  if (!connected.ok) throw new Error(`report-address ${connected.status} ${await connected.text()}`);
  const rua = w.rows('SELECT rua_address FROM domains WHERE id = ?', domainId)[0].rua_address as string;
  if (!rua) throw new Error('no report address');
  // Before the record exists, the domain page's check says nothing is live; then the record is added by hand.
  await w.api(token, 'GET', `/api/domains/${domainId}/dns-check`);
  w.cf.doh[`_dmarc.${domain}`] = [`v=DMARC1; p=none; rua=mailto:${rua}`];
  w.cf.doh[domain] = ['v=spf1 -all'];
  const check = await w.json(await w.api(token, 'GET', `/api/domains/${domainId}/dns-check`));
  if (!check.has_rua) throw new Error(`dns-check did not see the record: ${JSON.stringify(check)}`);
  await w.api(token, 'GET', `/api/domains/${domainId}/dns-check`); // seen again: still counted once
  await settle();
  if (opts.cron) { await opts.cron(w); await settle(); }
  await w.firstReport(workspaceId, domainId, domain, 'manual-1');
  await settle();
  return { ...w, events: w.events(), workspaceId, domainId, analyticsId: w.analyticsIdOf(workspaceId)! };
}

/** Sign-up with GitHub (a new account and workspace), then a later sign-in with GitHub. */
export async function runOAuthSignup() {
  const w = world();
  const first = await w.github();
  if (first.status !== 302) throw new Error(`github callback ${first.status} ${await first.text()}`);
  await settle();
  const workspaceId = w.workspaceOf(w.github_profile.email);
  if (!workspaceId) throw new Error(`no workspace after GitHub sign-up: ${first.headers.get('location')}`);
  const again = await w.github();
  if (again.status !== 302) throw new Error(`github sign-in ${again.status}`);
  await settle();
  return { ...w, events: w.events(), workspaceId, analyticsId: w.analyticsIdOf(workspaceId)! };
}
