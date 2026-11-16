// Who may do what, the card flow through Stripe-hosted Checkout, the return URL, the portal and isolation between workspaces.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { makeEnv, setupOwner } from '../auth/helpers';
import { billingWorld, call, json, rows, BASE, flushBackground, type World } from './world';
import { delegatedKey } from '../auth/grant-fixture';
import { CARD_DETAILS } from '../helpers/card-text';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const stripeCalls = (w: World) => w.fake.calls.length;

describe('billing is off unless the hosted service has it configured', () => {
  const PATHS: Array<[string, string]> = [
    ['GET', '/api/billing'], ['GET', '/api/billing/orders'], ['GET', '/api/billing/orders/ord_00000000000000000000000000000000'], ['GET', '/api/billing/domains/1'],
    ['POST', '/api/billing/card-session'], ['POST', '/api/billing/portal-session'], ['POST', '/api/billing/orders'], ['GET', '/api/billing/checkout/return?session_id=cs_1'],
    ['POST', '/api/stripe/webhook'], ['GET', '/api/operator/orders'], ['POST', '/api/operator/orders/ord_00000000000000000000000000000000/started'],
  ];
  it('hosted without Stripe settings: every billing route is a 404, with or without a login', async () => {
    const w = await billingWorld({}, { stripe: false });
    for (const [m, p] of PATHS) {
      expect((await call(w.env, m, p)).status, `${m} ${p} anonymous`).toBe(404);
      expect((await w.api(w.owner, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p} signed in`).toBe(404);
    }
    expect(stripeCalls(w)).toBe(0);
  });
  it('a full sk_ key keeps billing off (and says why only in the preflight)', async () => {
    const w = await billingWorld({ STRIPE_SECRET_KEY: 'sk_test_FULLACCESSKEY0123' });
    for (const [m, p] of PATHS) expect((await w.api(w.owner, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(404);
  });
  it('self-host has none of the routes either, even with the settings present', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMigratedD1();
    const env = makeEnv(db, { STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', OWNER_EMAIL: 'owner@example.com' });
    const token = await setupOwner(env);
    for (const [m, p] of PATHS) {
      const res = await call(env, m, p, { key: token, body: m === 'POST' ? {} : undefined });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect((await res.json() as { error: string }).error, `${m} ${p}`).toMatch(/not found/i);
    }
    expect((await call(env, 'POST', '/api/stripe/webhook', { body: {} })).status).toBe(404);
    expect((await call(env, 'GET', '/api/billing')).status).toBe(404);
  });
});

describe('roles and sessions', () => {
  it('every role can view; only the owner gets actions, and a refused action never reaches Stripe', async () => {
    const w = await billingWorld();
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const member = await w.addMember(w.owner.workspaceId, 'member@example.com', 'member');
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    for (const p of [w.owner, admin, member]) {
      const g = await json(await w.api(p, 'GET', '/api/billing'));
      expect(g).toMatchObject({ enabled: true, role: p === w.owner ? 'owner' : p === admin ? 'admin' : 'member', can_manage: p === w.owner });
      expect(g.offer).toMatchObject({ id: 'fix-one-domain', amount: 14900, currency: 'usd' });
      expect((await w.api(p, 'GET', `/api/billing/domains/${id}`)).status).toBe(200);
    }
    expect((await json(await w.api(admin, 'GET', `/api/billing/domains/${id}`))).can_buy).toBe(false);
    const before = stripeCalls(w);
    for (const p of [admin, member]) {
      for (const [path, body] of [['/api/billing/card-session', {}], ['/api/billing/portal-session', {}], ['/api/billing/orders', { domain_id: id, offer: 'fix-one-domain' }]] as const) {
        const res = await w.api(p, 'POST', path, body);
        expect(res.status, `${p.email} ${path}`).toBe(403);
        expect((await json(res)).code).toBe('owner_required');
      }
    }
    expect(stripeCalls(w)).toBe(before);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBeNull();
  });

  it('refuses anonymous callers, API keys and agent credentials: money moves from a browser session only', async () => {
    const w = await billingWorld();
    expect((await call(w.env, 'GET', '/api/billing')).status).toBe(401);
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    const k = await delegatedKey(w.db as never, { workspaceId: w.owner.workspaceId, userId: uid, name: 'k', domain: 'acme.com', kind: 'service' });
    for (const [m, p] of [['GET', '/api/billing'], ['POST', '/api/billing/card-session'], ['POST', '/api/billing/orders']] as const) {
      const res = await call(w.env, m, p, { key: k.key, body: m === 'POST' ? {} : undefined });
      expect([401, 403], `${m} ${p} -> ${res.status}`).toContain(res.status);
    }
    expect(stripeCalls(w)).toBe(0);
  });

  it('a cookie session needs a same-origin request for every state-changing route (CSRF)', async () => {
    const w = await billingWorld();
    const cookie = await w.cookieFor('owner@example.com');
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    const operatorCookie = await w.cookieFor('operator@example.com');
    const ord = 'ord_00000000000000000000000000000000';
    const cases: Array<[string, string, unknown, string, string]> = [
      ['POST', '/api/billing/card-session', {}, cookie, w.owner.workspaceId], ['POST', '/api/billing/portal-session', {}, cookie, w.owner.workspaceId],
      ['POST', '/api/billing/orders', { domain_id: id, offer: 'fix-one-domain' }, cookie, w.owner.workspaceId],
      ['POST', `/api/operator/orders/${ord}/started`, {}, operatorCookie, w.operator.workspaceId], ['POST', `/api/operator/orders/${ord}/done`, {}, operatorCookie, w.operator.workspaceId],
    ];
    for (const [m, p, body, c, workspace] of cases) {
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
        const res = await call(w.env, m, p, { body, headers: { cookie: c, ...headers } });
        expect(res.status, `${p} ${JSON.stringify(headers)}`).toBe(403);
      }
      const same = await call(w.env, m, p, { body, headers: { cookie: c, origin: BASE, 'x-workspace-id': workspace } });
      expect(same.status, `${p} same-origin`).not.toBe(403);
    }
    // nothing foreign reached Stripe or the database
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect(w.fake.state.invoices.size).toBe(0);
    // the webhook is exempt from CSRF (it has no cookie) but needs the signature
    expect((await call(w.env, 'POST', '/api/stripe/webhook', { headers: { origin: 'https://stripe.com' }, body: {} })).status).toBe(400);
  });
});

describe('the card: Stripe-hosted Checkout, one customer per workspace', () => {
  it('creates the customer on first need with the workspace in its metadata, binds the session, and the return sets the default card', async () => {
    const w = await billingWorld();
    expect(w.fake.state.customers.size).toBe(0);
    const before = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(before).toMatchObject({ has_customer: false, card: null, billing_email: 'owner@example.com' });
    expect(w.fake.state.customers.size).toBe(0); // viewing creates nothing

    const { started, sessionId, response, back } = await w.addCard(w.owner, 'ok', '/domains/9?order=fix-one-domain');
    expect(started.url).toContain('/pay/cs_');
    const cust = [...w.fake.state.customers.values()][0];
    expect(cust).toMatchObject({ email: 'owner@example.com', metadata: { workspace_id: w.owner.workspaceId } });
    const session = w.fake.state.sessions.get(sessionId)!;
    expect(session).toMatchObject({ mode: 'setup', customer: cust.id, client_reference_id: w.owner.workspaceId, payment_method_types: ['card'] });
    expect(session.metadata).toMatchObject({ workspace_id: w.owner.workspaceId, purpose: 'add_card' });
    expect(session.success_url).toContain('/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}');
    expect(session.cancel_url).toContain(`/#/w/${w.owner.workspaceId}/domains/9?order=fix-one-domain`);
    expect(rows(w.db, 'SELECT workspace_id, user_id, purpose, return_path, status FROM billing_checkout_sessions')).toEqual([
      { workspace_id: w.owner.workspaceId, user_id: expect.any(String), purpose: 'add_card', return_path: '/domains/9?order=fix-one-domain', status: 'completed' },
    ]);

    expect(response.status).toBe(303);
    expect(back).toContain(`session_id=${sessionId}`);
    expect(response.headers.get('location')).toBe(`/#/w/${w.owner.workspaceId}/domains/9?order=fix-one-domain&card=added`);
    const after = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(after).toMatchObject({ has_customer: true, card: { brand: 'visa', last4: '4242' }, billing_email: 'owner@example.com' });
    expect(after.card.exp_year).toBeGreaterThan(2000);
    expect(JSON.stringify(rows(w.db, 'SELECT * FROM billing_checkout_sessions'))).not.toMatch(CARD_DETAILS); // the card is read from Stripe, never stored
    expect(JSON.stringify(rows(w.db, 'SELECT * FROM workspaces'))).not.toMatch(CARD_DETAILS);
    expect(JSON.stringify(after)).not.toMatch(/cus_|pm_|seti_/);
    await flushBackground();
    expect(w.audits(w.owner.workspaceId)).toEqual(['billing.card_session_started', 'billing.card_added']);
  });

  it('two concurrent requests create exactly one customer', async () => {
    const w = await billingWorld();
    const res = await Promise.all([w.api(w.owner, 'POST', '/api/billing/card-session', {}), w.api(w.owner, 'POST', '/api/billing/card-session', {})]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(w.fake.state.customers.size).toBe(1);
    const stored = rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c;
    expect(stored).toBe([...w.fake.state.customers.keys()][0]);
    const keys = w.fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/customers').map((c) => c.headers.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`rsm-cust-${w.owner.workspaceId}`]));
  });

  it('webhook and return are interchangeable: the second finds the default set and writes one audit entry', async () => {
    const w = await billingWorld();
    const started = await json(await w.api(w.owner, 'POST', '/api/billing/card-session', {}));
    const sessionId = started.url.split('/pay/')[1];
    w.fake.completeCheckout(sessionId, { card: 'ok' }); // queues checkout.session.completed
    await w.fake.flush(); // the webhook wins the race
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('completed');
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).card).toMatchObject({ last4: '4242' });
    const back = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(back.headers.get('location')).toMatch(/card=added$/);
    await flushBackground();
    expect(w.audits(w.owner.workspaceId).filter((a) => a === 'billing.card_added')).toHaveLength(1);
  });

  it('a webhook for a Checkout session we did not start is ignored', async () => {
    const w = await billingWorld();
    const { customerId } = { customerId: 'cus_other' };
    const ev = w.fake.makeEvent('checkout.session.completed', { id: 'cs_test_foreign', object: 'checkout.session', mode: 'setup', customer: customerId, status: 'complete', metadata: { workspace_id: w.owner.workspaceId } });
    const res = await w.sendEvent(ev);
    expect(res.status).toBe(200);
    expect(rows(w.db, "SELECT outcome FROM billing_events WHERE id = ?", ev.id)[0].outcome).toBe('unknown_session');
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBeNull();
  });
});

describe('the return URL cannot be forged', () => {
  const noEffect = async (w: World, p: typeof w.owner, location: string | null, sessionId: string) => {
    expect(location).toMatch(new RegExp(`^/#/w/${p.workspaceId}/settings$|^/$|card=error`));
    void sessionId;
  };

  it('an unknown session id has no effect and does not leak', async () => {
    const w = await billingWorld();
    await json(await w.api(w.owner, 'POST', '/api/billing/card-session', {}));
    const r = await call(w.env, 'GET', '/api/billing/checkout/return?session_id=cs_test_doesnotexist', { key: w.owner.token, headers: w.h(w.owner) });
    expect(r.status).toBe(303);
    await noEffect(w, w.owner, r.headers.get('location'), 'x');
    expect(r.headers.get('location')).toBe(`/#/w/${w.owner.workspaceId}/settings`);
    for (const bad of ['', 'x', 'cs_', '../../etc', 'cs_test_a b', `cs_${'a'.repeat(400)}`]) {
      expect((await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${encodeURIComponent(bad)}`, { key: w.owner.token, headers: w.h(w.owner) })).headers.get('location')).toBe(`/#/w/${w.owner.workspaceId}/settings`);
    }
    expect([...w.fake.state.customers.values()].every((c) => !c.invoice_settings?.default_payment_method)).toBe(true);
  });

  it("another workspace's session id behaves as unknown: nothing is attached, nothing completed", async () => {
    const w = await billingWorld();
    w.fake.setWebhookTarget(null); // only the browser's return is under test here
    const started = await json(await w.api(w.owner, 'POST', '/api/billing/card-session', {}));
    const sessionId = started.url.split('/pay/')[1];
    w.fake.completeCheckout(sessionId, { card: 'ok' }); // the victim really completed it at Stripe
    const stranger = await w.person('stranger@example.com');
    const r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: stranger.token, headers: w.h(stranger) });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/#/w/${stranger.workspaceId}/settings`);
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('open');
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', stranger.workspaceId)[0].c).toBeNull();
    expect([...w.fake.state.customers.values()].every((c) => !c.invoice_settings?.default_payment_method)).toBe(true);
    // not signed in at all: the same
    const anon = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`);
    expect(anon.headers.get('location')).toBe('/');
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('open');
  });

  it('a session the customer did not complete sets nothing and comes back as canceled', async () => {
    const w = await billingWorld();
    w.fake.setWebhookTarget(null);
    const started = await json(await w.api(w.owner, 'POST', '/api/billing/card-session', { return_path: '/settings' }));
    const sessionId = started.url.split('/pay/')[1];
    const r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(r.headers.get('location')).toBe(`/#/w/${w.owner.workspaceId}/settings?card=canceled`);
    expect([...w.fake.state.customers.values()][0].invoice_settings?.default_payment_method ?? null).toBeNull();
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('open');
  });

  it("a session whose customer is not the workspace's customer (or whose metadata disagrees) attaches nothing", async () => {
    const w = await billingWorld();
    w.fake.setWebhookTarget(null);
    const started = await json(await w.api(w.owner, 'POST', '/api/billing/card-session', {}));
    const sessionId = started.url.split('/pay/')[1];
    w.fake.completeCheckout(sessionId, { card: 'ok' });
    // Stripe says a different customer saved the card
    const session = w.fake.state.sessions.get(sessionId)!;
    const realCustomer = session.customer;
    session.customer = 'cus_someone_else';
    let r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(r.headers.get('location')).toMatch(/card=error$/);
    session.customer = realCustomer;
    // metadata names another workspace
    session.metadata = { ...session.metadata, workspace_id: 'ws_other' };
    r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(r.headers.get('location')).toMatch(/card=error$/);
    session.metadata = { ...session.metadata, workspace_id: w.owner.workspaceId };
    // the workspace's stored customer is no longer the one the session was started for
    rows(w.db, 'SELECT 1'); w.db.sqlite.prepare("UPDATE workspaces SET stripe_customer_id = 'cus_replaced' WHERE id = ?").run(w.owner.workspaceId);
    r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(r.headers.get('location')).toMatch(/card=error$/);
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('open');
    expect(realCustomer && w.fake.state.customers.get(realCustomer)!.invoice_settings?.default_payment_method).toBeFalsy();
  });

  it('the return never marks an order paid', async () => {
    const w = await billingWorld();
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    w.fake.setWebhookTarget(null); // no webhook: only the browser's return could move things
    const bought = await json(await w.buy(w.owner, id));
    expect(bought.outcome).toBe('processing');
    const again = await w.addCard(w.owner);
    expect(again.response.headers.get('location')).toMatch(/card=added$/);
    expect(w.order(bought.order.id).status).toBe('pending');
  });

  it('the person returning must (still) own the workspace the session was started for', async () => {
    const w = await billingWorld();
    w.fake.setWebhookTarget(null);
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const started = await json(await w.api(w.owner, 'POST', '/api/billing/card-session', {}));
    const sessionId = started.url.split('/pay/')[1];
    w.fake.completeCheckout(sessionId, { card: 'ok' });
    const r = await call(w.env, 'GET', `/api/billing/checkout/return?session_id=${sessionId}`, { key: admin.token, headers: w.h(admin) });
    expect(r.headers.get('location')).toBe(`/#/w/${admin.workspaceId}/settings`);
    expect(rows(w.db, 'SELECT status FROM billing_checkout_sessions')[0].status).toBe('open');
  });

  it('works for a person in several workspaces although the navigation carries no X-Workspace-Id', async () => {
    const w = await billingWorld();
    const second = await json(await call(w.env, 'POST', '/api/workspaces', { key: w.owner.token, body: { name: 'Second' } }));
    const started = await json(await call(w.env, 'POST', '/api/billing/card-session', { key: w.owner.token, headers: { 'x-workspace-id': second.id }, body: {} }));
    const sessionId = started.url.split('/pay/')[1];
    const back = w.fake.completeCheckout(sessionId, { card: 'ok' });
    const r = await call(w.env, 'GET', back.replace(/^https?:\/\/[^/]+/, ''), { key: w.owner.token }); // no workspace header: oldest membership is the first workspace
    expect(r.headers.get('location')).toBe(`/#/w/${second.id}/settings?card=added`);
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', second.id)[0].c).toMatch(/^cus_/);
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBeNull();
  });

  it('return paths: only the app\'s own routes are stored; every forgery falls back to Settings', async () => {
    const w = await billingWorld();
    await w.api(w.owner, 'POST', '/api/billing/card-session', { return_path: '/domains/3?order=fix-one-domain' });
    const attempts = ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/settings%0d%0aSet-Cookie:x=1', '/domains/1/../../x', '/api/billing', 42, { a: 1 }];
    for (const p of attempts) {
      const started = await w.api(w.owner, 'POST', '/api/billing/card-session', { return_path: p });
      expect(started.status, JSON.stringify(p)).toBe(200);
    }
    expect(rows(w.db, 'SELECT return_path FROM billing_checkout_sessions ORDER BY rowid').map((r) => r.return_path)).toEqual(['/domains/3?order=fix-one-domain', ...attempts.map(() => '/settings')]);
    for (const s of [...w.fake.state.sessions.values()].slice(1)) {
      expect(s.cancel_url).toMatch(new RegExp(`^${BASE.replace(/[.]/g, '\\.')}/#/w/${w.owner.workspaceId}/settings\\?card=canceled$`));
      expect(s.success_url.startsWith(`${BASE}/api/billing/checkout/return?session_id=`)).toBe(true);
    }
  });
});

describe('the billing portal', () => {
  it('is created per click for the owner, returns to the Settings page, and needs a customer', async () => {
    const w = await billingWorld();
    const none = await w.api(w.owner, 'POST', '/api/billing/portal-session', {});
    expect(none.status).toBe(409);
    expect((await json(none)).code).toBe('no_customer');
    await w.addCard(w.owner);
    const a = await json(await w.api(w.owner, 'POST', '/api/billing/portal-session', {}));
    const b = await json(await w.api(w.owner, 'POST', '/api/billing/portal-session', {}));
    expect(a.url).toMatch(/\/portal\//);
    expect(a.url).not.toBe(b.url);
    expect(w.fake.state.portalSessions.size).toBe(2);
    const ps = [...w.fake.state.portalSessions.values()][0];
    expect(ps.customer).toBe(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c);
    expect(ps.return_url).toBe(`${BASE}/#/w/${w.owner.workspaceId}/settings`);
  });
});

describe('rate limits', () => {
  it('limit card and portal sessions per workspace (and per user) with 429 and Retry-After, before Stripe is called', async () => {
    const w = await billingWorld();
    let last!: Response;
    for (let i = 0; i < 10; i++) { last = await w.api(w.owner, 'POST', '/api/billing/card-session', {}); expect(last.status).toBe(200); }
    const calls = stripeCalls(w);
    last = await w.api(w.owner, 'POST', '/api/billing/card-session', {});
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await w.api(w.owner, 'POST', '/api/billing/portal-session', {})).status).toBe(429); // shared budget with the card session
    expect(stripeCalls(w)).toBe(calls);
  });
  it('limit purchase attempts: five in ten minutes, refused ones included', async () => {
    const w = await billingWorld();
    for (let i = 0; i < 5; i++) expect((await w.buy(w.owner, 999)).status).toBe(404);
    const res = await w.buy(w.owner, 999);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
  it('a second workspace has its own budget', async () => {
    const w = await billingWorld();
    for (let i = 0; i < 5; i++) await w.buy(w.owner, 999);
    expect((await w.buy(w.owner, 999)).status).toBe(429);
    const other = await w.person('other@example.com');
    expect((await w.buy(other, 999)).status).toBe(404);
  });
});

describe('isolation between workspaces', () => {
  it("another workspace's order, domain and orders list are as good as missing", async () => {
    const w = await billingWorld();
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    const bought = await json(await w.buy(w.owner, id));
    await w.fake.flush();
    const other = await w.person('other@example.com');
    const otherDomain = w.addDomain(other.workspaceId, 'other.org');
    expect((await w.api(other, 'GET', `/api/billing/orders/${bought.order.id}`)).status).toBe(404);
    expect((await w.api(other, 'GET', `/api/billing/domains/${id}`)).status).toBe(404);
    expect((await json(await w.api(other, 'GET', '/api/billing/orders'))).orders).toEqual([]);
    expect((await json(await w.api(other, 'GET', '/api/billing'))).orders).toEqual([]);
    const missing = await w.api(other, 'GET', '/api/billing/orders/ord_00000000000000000000000000000000');
    const foreign = await w.api(other, 'GET', `/api/billing/orders/${bought.order.id}`);
    expect([foreign.status, await foreign.text()]).toEqual([missing.status, await missing.text()]);
    // buying someone else's domain, or with someone else's card: 404 / card_required; nothing is created
    const callsBefore = w.fake.state.invoices.size;
    expect((await w.buy(other, id)).status).toBe(404);
    const noCard = await w.buy(other, otherDomain);
    expect(noCard.status).toBe(409);
    expect((await json(noCard)).code).toBe('card_required');
    expect(w.fake.state.invoices.size).toBe(callsBefore);
    expect(rows(w.db, 'SELECT workspace_id FROM billing_orders').map((r) => r.workspace_id)).toEqual([w.owner.workspaceId]);
  });
});

describe('owner change', () => {
  it('the new owner sees the same customer and card; the old owner loses access', async () => {
    const w = await billingWorld();
    const next = await w.addMember(w.owner.workspaceId, 'next@example.com', 'admin');
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    const customerBefore = rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c;
    const nextId = rows(w.db, "SELECT id FROM users WHERE email = 'next@example.com'")[0].id;
    const moved = await w.api(w.owner, 'POST', `/api/workspaces/${w.owner.workspaceId}/transfer-ownership`, { user_id: nextId });
    expect(moved.status).toBe(200);

    const seen = await json(await w.api(next, 'GET', '/api/billing'));
    expect(seen).toMatchObject({ role: 'owner', can_manage: true, has_customer: true, card: { last4: '4242' } });
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBe(customBefore(customerBefore));
    const old = await w.api(w.owner, 'POST', '/api/billing/card-session', {});
    expect(old.status).toBe(403);
    expect((await w.api(w.owner, 'POST', '/api/billing/orders', { domain_id: id, offer: 'fix-one-domain' })).status).toBe(403);
    expect((await w.api(w.owner, 'POST', '/api/billing/portal-session', {})).status).toBe(403);
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).can_manage).toBe(false);
    const bought = await w.buy(next, id);
    expect(bought.status).toBe(201);
    expect(rows(w.db, 'SELECT buyer_email FROM billing_orders')[0].buyer_email).toBe('next@example.com');
  });
});
const customBefore = (x: string) => x;

describe('the Settings and domain views', () => {
  it('carry the offer from the Stripe price, the terms and refund-policy links, and no Stripe ids', async () => {
    const w = await billingWorld();
    const id = w.addDomain(w.owner.workspaceId, 'acme.com');
    const g = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(g.offer).toMatchObject({
      id: 'fix-one-domain', name: 'Fix one domain', amount: 14900, currency: 'usd',
      scope: 'The authentication part of Fix it, for one domain: every authorized sender confirmed, SPF and DKIM fixed, DMARC moved to reject.',
      refund_rule: 'Until we send the written note that the domain is done, you can ask for the full fee back.',
      next_steps: 'We will write to you about the access the work needs. The work starts when you have given it, and ends with our written note that the domain is done.',
    });
    expect(g).toMatchObject({ terms_url: 'https://readysetmail.com/terms', refund_policy_url: 'https://readysetmail.com/refund-policy' });
    const dv = await json(await w.api(w.owner, 'GET', `/api/billing/domains/${id}`));
    expect(dv).toMatchObject({ domain: { id, name: 'acme.com' }, can_buy: true, open_order: null, card: null, has_customer: false });
    // the amount follows Stripe's price, not code
    w.fake.seedPrice({ id: 'price_new', lookup_key: 'rsm_fix_one_domain', unit_amount: 19900 });
    w.db.sqlite.prepare('DELETE FROM billing_price_cache').run();
    for (const [pid, p] of w.fake.state.prices) if (pid !== 'price_new') p.active = false;
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).offer.amount).toBe(19900);
  });
  it('hide the offer (and refuse buying) while the price is misconfigured, without failing the page', async () => {
    const w = await billingWorld();
    w.addDomain(w.owner.workspaceId, 'acme.com');
    for (const p of w.fake.state.prices.values()) p.active = false;
    const g = await w.api(w.owner, 'GET', '/api/billing');
    expect(g.status).toBe(200);
    expect(await json(g)).toMatchObject({ offer: null, offer_problem: 'price_misconfigured' });
  });
});
