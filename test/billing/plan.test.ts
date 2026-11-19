// The hosted plan "pay as you go" (src/billing/plan.ts): one free place, a card for more, extra domains billed once proven. Fake Stripe only.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { billingWorld, flushBackground, json, rows, type World } from './world';
import { PLAN_ADD_ONS, hostedPlanOn, planItems, syncPlan } from '../../src/billing/plan';
import { runBillingJob } from '../../src/billing/reconcile';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PLAN = { HOSTED_PLAN: 'pay_as_you_go' };
const seedPrices = (w: World) => {
  w.fake.seedPrice({ id: 'price_year', lookup_key: 'rsm_extra_domain_yearly', type: 'recurring', recurring: { interval: 'year', interval_count: 1 }, unit_amount: 5000 });
  w.fake.seedPrice({ id: 'price_month', lookup_key: 'rsm_extra_domain_monthly', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, unit_amount: 500 });
};
const planRow = (w: World) => rows(w.db, 'SELECT * FROM workspace_plans WHERE workspace_id = ?', w.owner.workspaceId)[0];
const add = (w: World, domain: string) => w.api(w.owner, 'POST', '/api/domains', { domain });
const sync = (w: World) => syncPlan(w.env as never, w.env.DB, w.owner.workspaceId);

describe('the switch', () => {
  it('is on only for hosted + Stripe + HOSTED_PLAN=pay_as_you_go', async () => {
    const on = await billingWorld(PLAN);
    const off = await billingWorld();
    const noStripe = await billingWorld(PLAN, { stripe: false });
    expect(hostedPlanOn(on.env as never)).toBe(true);
    expect(hostedPlanOn(off.env as never)).toBe(false);
    expect(hostedPlanOn(noStripe.env as never)).toBe(false);
    expect(hostedPlanOn({ ...on.env, HOSTED_PLAN: 'other' } as never)).toBe(false);
    expect(hostedPlanOn({ ...on.env, MODE: 'selfhost' } as never)).toBe(false);
  });

  it('off: GET /api/billing has no plan, POST /api/billing/plan is 404, and the second domain is limited exactly as before (default places)', async () => {
    const w = await billingWorld();
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).plan).toBeNull();
    expect((await w.api(w.owner, 'POST', '/api/billing/plan', { interval: 'month' })).status).toBe(404);
    for (const d of ['one-corp.com', 'two-corp.com']) expect((await add(w, d)).status).toBe(202);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM domain_claims')[0].n).toBe(2);
  });

  it('with the Stripe settings unset the routes are 404 even with the switch set', async () => {
    const w = await billingWorld(PLAN, { stripe: false });
    expect((await w.api(w.owner, 'GET', '/api/billing')).status).toBe(404);
    expect((await w.api(w.owner, 'POST', '/api/billing/plan', { interval: 'month' })).status).toBe(404);
    expect((await add(w, 'one-corp.com')).status).toBe(202);
    expect((await add(w, 'two-corp.com')).status).toBe(202);
  });
});

describe('the free place', () => {
  it('a pending claim alone uses the free place: the second name is refused 402 card_required, naming the waiting claim', async () => {
    const w = await billingWorld(PLAN);
    expect((await add(w, 'one-corp.com')).status).toBe(202);
    const res = await add(w, 'two-corp.com');
    expect(res.status).toBe(402);
    const b = await json(res);
    expect(b).toMatchObject({ code: 'card_required', can_manage: true, prices: { month: 'USD 5', year: 'USD 50' } });
    expect(b.error).toContain('Your free plan covers one domain, and a domain waiting for proof counts. To add more, add a card in Settings → Billing: each extra domain is $50 a year (or $5 a month), charged only once it is proven.');
    expect(b.error).toContain('one-corp.com');
    expect(rows(w.db, 'SELECT COUNT(*) n FROM domain_claims')[0].n).toBe(1);
  });

  it('a second domain next to a proven one is refused 402 card_required; a non-owner is told to ask the owner', async () => {
    const w = await billingWorld(PLAN);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    const member = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const res = await w.api(member, 'POST', '/api/domains', { domain: 'two-corp.com' });
    expect(res.status).toBe(402);
    const b = await json(res);
    expect(b.can_manage).toBe(false);
    expect(b.error).toContain('Ask the workspace owner to add a card in Settings → Billing.');
    expect(b.error).not.toContain('To add more, add a card');
  });

  it('with a card on file a second domain is allowed as a claim and is not billed', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    expect((await add(w, 'two-corp.com')).status).toBe(202);
    await flushBackground();
    expect(planRow(w)?.stripe_subscription_id ?? null).toBeNull();
    expect(w.fake.state.subscriptions.size).toBe(0);
  });
});

describe('billing', () => {
  it('bills the proven, live domains beyond the free one: quantity 1 once proven, 0 on removal, never deleted', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    expect((await add(w, 'two-corp.com')).status).toBe(202);
    await sync(w);
    expect(w.fake.state.subscriptions.size).toBe(0); // a claim is never billed

    const id = w.addDomain(w.owner.workspaceId, 'two-corp.com'); // proven
    await sync(w);
    const sub = [...w.fake.state.subscriptions.values()][0] as any;
    expect(sub.items.data).toHaveLength(1);
    expect(sub.items.data[0].price.id).toBe('price_year');
    expect(sub.items.data[0].quantity).toBe(1);
    expect(sub.metadata.workspace_id).toBe(w.owner.workspaceId);
    expect(planRow(w)).toMatchObject({ quantity: 1, sync_error: null, interval: 'year' });
    expect(w.fake.calls.filter((c: any) => c.path === '/v1/subscriptions' && c.method === 'POST')[0].form.proration_behavior).toBe('create_prorations');

    expect((await w.api(w.owner, 'DELETE', `/api/domains/${id}`)).status).toBe(200);
    await flushBackground();
    expect(planRow(w).quantity).toBe(0);
    expect(w.fake.state.subscriptionItems.values().next().value.quantity).toBe(0);
    expect(w.fake.state.subscriptions.size).toBe(1);
  });

  it('an unproven (lost proof) domain is not billed', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    w.addDomain(w.owner.workspaceId, 'two-corp.com');
    await w.addCard(w.owner);
    await sync(w);
    expect(planRow(w).quantity).toBe(1);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy', proof_lost_at = 1 WHERE domain = 'two-corp.com'").run();
    await sync(w);
    expect(planRow(w).quantity).toBe(0);
  });

  it('the owner chooses monthly before the first extra domain is billed, and not after', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    const member = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    expect((await w.api(member, 'POST', '/api/billing/plan', { interval: 'month' })).status).toBe(403);
    expect((await w.api(w.owner, 'POST', '/api/billing/plan', { interval: 'weekly' })).status).toBe(400);
    expect((await w.api(w.owner, 'POST', '/api/billing/plan', { interval: 'month' })).status).toBe(200);
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).plan.interval).toBe('month');
    w.addDomain(w.owner.workspaceId, 'acme.com');
    w.addDomain(w.owner.workspaceId, 'two-corp.com');
    await w.addCard(w.owner);
    await sync(w);
    expect((w.fake.state.subscriptionItems.values().next().value as any).price.id).toBe('price_month');
    const again = await w.api(w.owner, 'POST', '/api/billing/plan', { interval: 'year' });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('plan_started');
  });

  it('a Stripe failure never undoes the domain: it leaves sync_error, and the daily job syncs again', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    w.addDomain(w.owner.workspaceId, 'two-corp.com');
    w.fake.failNext('POST /v1/subscriptions', { status: 500, error: { type: 'api_error', message: 'boom' } });
    await w.addCard(w.owner); // the card arrives with two proven domains: the sync that follows is the one that fails
    await flushBackground();
    expect(rows(w.db, "SELECT COUNT(*) n FROM domains WHERE domain = 'two-corp.com'")[0].n).toBe(1);
    expect(planRow(w).sync_error).toMatch(/StripeError/);
    expect(planRow(w).stripe_subscription_id).toBeNull();
    await runBillingJob(w.env as never);
    expect(planRow(w)).toMatchObject({ quantity: 1, sync_error: null });
    expect(planRow(w).stripe_subscription_id).toBeTruthy();
  });

  it('a store that failed after the create, then a changed quantity: the retry finds the same subscription (one subscription, the new quantity)', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    w.addDomain(w.owner.workspaceId, 'two-corp.com');
    await w.addCard(w.owner);
    await flushBackground();
    expect(w.fake.state.subscriptions.size).toBe(1);
    w.db.sqlite.prepare('UPDATE workspace_plans SET stripe_subscription_id = NULL, stripe_item_id = NULL, quantity = 0 WHERE workspace_id = ?').run(w.owner.workspaceId); // the store failed
    w.addDomain(w.owner.workspaceId, 'three-corp.com'); // the quantity changed before the retry
    await sync(w);
    expect(w.fake.state.subscriptions.size).toBe(1);
    expect((w.fake.state.subscriptionItems.values().next().value as any).quantity).toBe(2);
    expect(planRow(w)).toMatchObject({ quantity: 2, sync_error: null });
    expect(planRow(w).stripe_subscription_id).toBeTruthy();
  });

  it('plan off: syncPlan does nothing', async () => {
    const w = await billingWorld();
    w.addDomain(w.owner.workspaceId, 'acme.com');
    w.addDomain(w.owner.workspaceId, 'two-corp.com');
    await sync(w);
    expect(planRow(w)).toBeUndefined();
    expect(w.fake.calls.filter((c: any) => /subscription/.test(c.path))).toHaveLength(0);
  });

  it('GET /api/billing shows the plan to the owner with prices; a member sees only whether there is a card', async () => {
    const w = await billingWorld(PLAN);
    seedPrices(w);
    w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    const own = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(own.plan).toEqual({ free_domains: 1, interval: 'year', prices: { month: { amount: 500, currency: 'usd' }, year: { amount: 5000, currency: 'usd' } }, billed_domains: 0, card_on_file: true, started: false });
    const member = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const theirs = await json(await w.api(member, 'GET', '/api/billing'));
    expect(theirs.plan.card_on_file).toBe(true);
    expect(theirs.card).toBeUndefined();
    expect(theirs.billing_email).toBeUndefined();
  });

  it('a price that is not recurring for its interval is refused (the price is null, not shown)', async () => {
    const w = await billingWorld(PLAN);
    w.fake.seedPrice({ id: 'price_year', lookup_key: 'rsm_extra_domain_yearly', type: 'one_time', unit_amount: 5000 });
    w.fake.seedPrice({ id: 'price_month', lookup_key: 'rsm_extra_domain_monthly', type: 'recurring', recurring: { interval: 'year', interval_count: 1 }, unit_amount: 500 });
    const plan = (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;
    expect(plan.prices).toEqual({ month: null, year: null });
  });
});

describe('planItems (the add-on hook)', () => {
  it('bills the extra-domain item for the interval', () => {
    expect(planItems(2, [])).toEqual([{ lookupKey: 'rsm_extra_domain_yearly', quantity: 2 }]);
    expect(planItems(3, [], 'month')).toEqual([{ lookupKey: 'rsm_extra_domain_monthly', quantity: 3 }]);
    expect(planItems(-1, [])[0]!.quantity).toBe(0);
  });
  it('an add-on whose price is open (null lookup key) bills nothing', () => {
    expect(PLAN_ADD_ONS['spf-flattening']!.lookupKey).toBeNull();
    expect(planItems(1, [{ addOn: 'spf-flattening', domainId: 7 }, { addOn: 'unknown', domainId: 8 }])).toEqual([{ lookupKey: 'rsm_extra_domain_yearly', quantity: 1 }]);
  });
  it('an add-on with a price is one item, quantity = the domains that have it', () => {
    const catalog = { 'spf-flattening': { label: 'SPF flattening', lookupKey: 'rsm_spf_flattening_yearly' } };
    expect(planItems(1, [{ addOn: 'spf-flattening', domainId: 7 }, { addOn: 'spf-flattening', domainId: 7 }, { addOn: 'spf-flattening', domainId: 9 }], 'year', catalog)).toEqual([
      { lookupKey: 'rsm_extra_domain_yearly', quantity: 1 }, { lookupKey: 'rsm_spf_flattening_yearly', quantity: 2 },
    ]);
  });
});

describe('the webhook and subscription invoices', () => {
  it('a subscription invoice (no order) is answered 200, changes no order and sends no "needs attention" mail', async () => {
    const w = await billingWorld(PLAN);
    const before = rows(w.db, 'SELECT * FROM billing_orders');
    for (const type of ['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required']) {
      const res = await w.sendEvent(w.fake.makeEvent(type, { id: 'in_sub1', object: 'invoice', customer: 'cus_x', subscription: 'sub_x', metadata: {} }));
      expect(res.status).toBe(200);
    }
    await flushBackground();
    expect(rows(w.db, 'SELECT * FROM billing_orders')).toEqual(before);
    expect(w.alertMails()).toHaveLength(0);
    expect(w.ownerMails()).toHaveLength(0);
  });
});
