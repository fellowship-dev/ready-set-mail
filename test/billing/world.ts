// Shared setup for the billing tests: a hosted installation with a fake Stripe wired in as `fetch`, and the fake's webhook delivered to the Worker.
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { Env } from '../../src/index';
import { handleApi } from '../../src/api/router';
import { BASE, call, ctx, enterCode, flushBackground, lastCodeFor, makeEnv, mailbox, pendingCookieOf, req, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { createFakeStripe, signStripePayload, type FakeStripe } from '../../e2e/support/fake-stripe.mjs';

export const WHSEC = 'whsec_testsecret0123456789';
export const KEY = 'rk_test_testkey0123456789';
export { BASE, call, ctx, flushBackground, signStripePayload };

export const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
export const json = async (res: Response) => (await res.json()) as any;

export interface Person { token: string; email: string; workspaceId: string }

export async function billingWorld(extraEnv: Record<string, unknown> = {}, opts: { stripe?: boolean } = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createMigratedD1();
  const stripeVars = opts.stripe === false ? {} : { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC };
  const env = makeEnv(db, { ...HOSTED_ENV, ...stripeVars, OWNER_EMAIL: 'operator@example.com', ...extraEnv }) as Env & { DB: D1Database };
  mailbox(env);
  const fake = createFakeStripe({ webhookSecret: WHSEC });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    return /^https:\/\/api\.stripe\.com\//.test(u) ? fake.fetch(input, init) : realFetch(input, init);
  });
  // Stripe's webhook delivery lands on the Worker's route, as Stripe's would.
  const connectWebhook = () => fake.setWebhookTarget(async (r: Request) => handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: r.headers, body: await r.text() }), env as never, ctx));
  connectWebhook();

  const person = async (email: string): Promise<Person> => {
    const token = await signupVerified(env, email);
    const me = await json(await call(env, 'GET', '/api/me', { key: token }));
    return { token, email, workspaceId: me.workspace_id };
  };
  const owner = await person('owner@example.com');
  const operator = await person('operator@example.com');

  /** A cookie session (what a browser has), for the CSRF checks. */
  const cookieFor = async (email: string, password = 'password-123') => {
    const res = await call(env, 'POST', '/api/auth/login', { body: { email, password } });
    const done = await enterCode(env, pendingCookieOf(res), await lastCodeFor(env, email));
    return done.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };

  const addDomain = (workspaceId: string, domain: string, extra = '') => {
    db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES (?, ?, ?, 'txt')").run(domain, `rua@reports.${domain}`, workspaceId);
    return (db.sqlite.prepare('SELECT id FROM domains WHERE domain = ?').get(domain) as { id: number }).id;
  };
  /** A member or admin of `workspaceId` with their own login (made behind the API's back). */
  const addMember = async (workspaceId: string, email: string, role: 'admin' | 'member') => {
    const p = await person(email);
    db.sqlite.prepare('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, (SELECT id FROM users WHERE email = ?), ?)').run(workspaceId, email, role);
    return { ...p, workspaceId }; // acts in that workspace (the person's own one is left alone)
  };
  const h = (p: Person) => ({ 'x-workspace-id': p.workspaceId });
  const api = (p: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(env, method, path, { key: p.token, body, headers: { ...h(p), ...headers } });

  /** Add a card the way a browser would: card session → hosted page → return. */
  const addCard = async (p: Person, kind: 'ok' | 'decline' | 'requires_action' = 'ok', returnPath = '/settings') => {
    const started = await json(await api(p, 'POST', '/api/billing/card-session', { return_path: returnPath }));
    const sessionId = started.url.split('/pay/')[1] as string;
    const back = fake.completeCheckout(sessionId, { card: kind });
    const r = await call(env, 'GET', back.replace('https://stripe.fake', '').replace(/^https?:\/\/[^/]+/, ''), { key: p.token, headers: h(p) });
    return { started, sessionId, back, response: r };
  };
  const buy = (p: Person, domainId: number, extra: Record<string, unknown> = {}) => api(p, 'POST', '/api/billing/orders', { domain_id: domainId, offer: 'fix-one-domain', ...extra });
  const sendEvent = async (ev: ReturnType<FakeStripe['makeEvent']>, opts: { secret?: string; t?: number; body?: string; headers?: Record<string, string> } = {}) => {
    const body = opts.body ?? JSON.stringify(ev);
    const sig = await signStripePayload(opts.secret ?? WHSEC, body, opts.t);
    return handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json', ...opts.headers }, body }), env as never, ctx);
  };
  const order = (id: string) => rows(db, 'SELECT * FROM billing_orders WHERE id = ?', id)[0];
  const ownerMails = () => mailbox(env).send.mock.calls.map((c) => c[0] as { to: string[]; subject: string; text: string }).filter((m) => m.to.includes('operator@example.com') && /New order/.test(m.subject));
  const audits = (workspaceId: string) => rows(db, "SELECT action, actor_id, actor_type FROM audit_log WHERE workspace_id = ? AND action LIKE 'billing.%' ORDER BY id", workspaceId).map((r) => r.action as string);
  return { db, env, fake, connectWebhook, owner, operator, person, cookieFor, addDomain, addMember, api, addCard, buy, sendEvent, order, ownerMails, audits, h };
}
export type World = Awaited<ReturnType<typeof billingWorld>>;
