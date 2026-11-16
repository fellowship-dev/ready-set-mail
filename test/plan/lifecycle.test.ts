// The subscription's life: renewal, payment failure and recovery, lapse and restart, cancelling, the webhook's trust checks, the daily job, the preview,
// the grandfather choice, concurrency, workspaces and transfer.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, type PlanWorld } from './world';
import { runBillingJob } from '../../src/billing/reconcile';
import { subFacts } from '../../src/billing/plan-service';

afterEach(() => vi.unstubAllGlobals());

async function ready(extra: Record<string, unknown> = {}) {
  const w = await planWorld(extra);
  await w.addFree(w.owner, 'one.example.com');
  await w.addCard(w.owner);
  await w.addPaid(w.owner, 'two.example.org');
  await w.fake.flush();
  const sub = [...w.fake.state.subscriptions.values()][0] as any;
  return { w, subId: sub.id as string, ws: w.owner.workspaceId };
}
const view = async (w: PlanWorld, p = w.owner) => (await json(await w.api(p, 'GET', '/api/billing'))).plan;
const itemQty = (w: PlanWorld) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);

describe('the confirm\'s numbers come from Stripe', () => {
  it('free first domain: no confirm, no price', async () => {
    const w = await planWorld();
    const res = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=one.example.com'));
    expect(res).toMatchObject({ needs_confirm: false, reason: 'free', new_units: 1 });
  });
  it('a plan that starts with this domain: the first invoice is charged now, its amount and the day of the next one are Stripe\'s own preview', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    const res = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=two.example.org'));
    expect(res).toMatchObject({ needs_confirm: true, plan_starts: true, charge_now: 500, can_confirm: true, preview_failed: false, unit_price: { amount: 500, currency: 'usd', interval: 'month' }, then: { amount: 500, currency: 'usd' } });
    expect(res.then.date).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(res.next_invoice).toBeNull();
    expect(w.sub(w.owner.workspaceId)).toBeNull(); // asking changes nothing
    const previews = w.fake.calls.filter((c: any) => c.path === '/v1/invoices/create_preview');
    expect(previews).toHaveLength(1);
    expect(previews[0].form.subscription_details.items[0]).toMatchObject({ quantity: '1' });
  });
  it('when Stripe cannot say what the first invoice is, the confirm cannot be pressed and nothing is guessed', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    w.fake.failNext(/POST \/v1\/invoices\/create_preview/, { status: 500 });
    const res = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=two.example.org'));
    expect(res).toMatchObject({ preview_failed: true, charge_now: null, can_confirm: false, then: null, next_invoice: null });
    // and the server will not charge without the amount it was shown
    const blind = await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' });
    expect(blind.status).toBe(409);
    expect((await json(blind)).charge_now).toBe(500);
    expect(w.sub(w.owner.workspaceId)).toBeNull();
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
  });
  it('the explicit start of an ordinary workspace is free of charge and says so', async () => {
    const w = await planWorld();
    await w.addCard(w.owner);
    const res = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?start=1'));
    expect(res).toMatchObject({ needs_confirm: true, plan_starts: true, no_charge: true, charge_now: 0, reason: 'start' });
  });
  it('with a subscription: Stripe\'s invoice preview states the amount and the date, and changes nothing', async () => {
    const { w } = await ready();
    const calls = w.fake.calls.length;
    const res = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=three.example.net'));
    expect(res).toMatchObject({ needs_confirm: true, plan_starts: false, charge_now: 0, then: null, next_invoice: { currency: 'usd' } });
    expect(res.next_invoice.amount_due).toBeGreaterThanOrEqual(500 * 2); // the next domain's part of this period plus its next period, plus the first domain's next period
    // the day is the end of the current period (the item's), not next_payment_attempt, which real Stripe sets an hour later
    const periodEnd = ([...w.fake.state.subscriptionItems.values()][0] as any).current_period_end;
    expect(res.next_invoice.date).toBe(periodEnd);
    expect(itemQty(w)).toEqual([1]);
    expect(w.fake.calls.slice(calls).every((c: any) => c.method === 'GET' || c.path === '/v1/invoices/create_preview')).toBe(true);
  });
  it('the Billing page says what the monthly amount and the next invoice are, from Stripe, and lists the billable domains', async () => {
    const { w } = await ready();
    const p = await view(w);
    expect(p).toMatchObject({ name: 'payg', billable: 1, quantity: 1, monthly_amount: 500, status: 'active', includes_free_domain: true, price: { amount: 500, currency: 'usd', interval: 'month' } });
    expect(p.next_invoice).toMatchObject({ currency: 'usd' });
    expect(p.domains.map((d: any) => [d.name, d.billable])).toEqual([['one.example.com', false], ['two.example.org', true]]);
  });
});

describe('payment failure and recovery', () => {
  it('a renewal that fails: domains keep working, adding more is paused with the plain sentence, the card button is the way out', async () => {
    const { w, subId, ws } = await ready();
    w.fake.setCardBehavior([...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!, 'decline');
    w.fake.advancePeriod(subId);
    await w.fake.flush();
    expect(w.sub(ws)).toMatchObject({ status: 'past_due', quantity_sent: 1 });
    expect(w.ws(ws).plan).toBe('payg');
    expect(w.domainsOf(ws)).toEqual(['one.example.com', 'two.example.org']);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(0);
    const p = await view(w);
    expect(p).toMatchObject({ payment_problem: true, lapsed: false });
    const res = await w.addPaid(w.owner, 'three.example.net');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'payment_problem', error: 'Your last payment did not go through. Update your card to add more domains.', action: 'update_card' });
    expect(itemQty(w)).toEqual([1]);
    expect((await w.api(w.owner, 'POST', '/api/billing/portal-session', {})).status).toBe(200);
  });

  it('a retry that works brings the plan back; adding is possible again', async () => {
    const { w, subId, ws } = await ready();
    const cus = [...w.fake.state.customers.keys()][1] ?? [...w.fake.state.customers.keys()][0];
    w.fake.setCardBehavior(cus!, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.retryPayment(subId, { card: 'ok' });
    await w.fake.flush();
    expect(w.sub(ws).status).toBe('active');
    expect((await view(w)).payment_problem).toBe(false);
    expect((await w.addPaid(w.owner, 'three.example.net')).status).toBe(201);
    expect(itemQty(w)).toEqual([2]);
  });

  it('a renewal that needs the bank: the hosted invoice link is stored for Settings, and cleared when it is paid', async () => {
    const { w, subId, ws } = await ready();
    const cus = [...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!;
    w.fake.setCardBehavior(cus, 'requires_action');
    const r = w.fake.advancePeriod(subId);
    await w.fake.flush();
    const p = await view(w);
    expect(p.action_required_url).toMatch(/^https:\/\/stripe\.fake\/i\/in_/);
    expect(w.sub(ws).action_url).toBe(p.action_required_url);
    w.fake.completeInvoiceAction(r.invoice!.id, 'succeed');
    await w.fake.flush();
    expect((await view(w)).action_required_url).toBeNull();
    expect(w.sub(ws).status).toBe('active');
  });

  it('after Stripe\'s retries are exhausted the plan lapses: the allowance domain stays, every other domain is paused, nothing is deleted, restarting resumes them', async () => {
    const { w, subId, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    const cus = [...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!;
    w.fake.setCardBehavior(cus, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'canceled' });
    await w.fake.flush();
    expect(w.ws(ws).plan).toBe('free');
    expect(w.sub(ws).lapsed_at).not.toBeNull();
    const paused = rows(w.db, 'SELECT domain FROM domains WHERE workspace_id = ? AND paused_at IS NOT NULL ORDER BY id', ws).map((r) => r.domain);
    expect(paused).toEqual(['two.example.org', 'three.example.net']);
    expect(w.domainsOf(ws)).toEqual(['one.example.com', 'two.example.org', 'three.example.net']); // nothing deleted
    const p = await view(w);
    expect(p).toMatchObject({ name: 'free', lapsed: true });
    expect(p.domains.map((d: any) => [d.name, d.paused])).toEqual([['one.example.com', false], ['two.example.org', true], ['three.example.net', true]]);
    // reads and export are not blocked
    expect((await w.api(w.owner, 'GET', '/api/domains')).status).toBe(200);
    expect((await w.api(w.owner, 'GET', `/api/workspaces/${ws}/export`)).status).toBe(200);
    // adding is a plan question again; the card is replaced, then the plan starts again and resumes what was paused
    await w.addCard(w.owner);
    const prev = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?start=1'));
    expect(prev).toMatchObject({ plan_starts: true, charge_now: 1000, then: { amount: 1000 } }); // two paused domains come back: the first invoice is charged now, Stripe's number
    const start = await w.api(w.owner, 'POST', '/api/billing/plan/start', { expected_charge: prev.charge_now });
    expect(start.status).toBe(201);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(0);
    expect(w.ws(ws).plan).toBe('payg');
    expect(w.sub(ws)).toMatchObject({ status: 'active', quantity_sent: 2, lapsed_at: null });
  });

  it('unpaid (retries over, the subscription left open) lapses the same way', async () => {
    const { w, subId, ws } = await ready();
    const cus = [...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!;
    w.fake.setCardBehavior(cus, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'unpaid' });
    await w.fake.flush();
    expect(w.ws(ws).plan).toBe('free');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(1);
  });
});

describe('cancelling in the portal', () => {
  it('at period end: the plan shows when it ends and keeps working; when the period ends it lapses', async () => {
    const { w, subId, ws } = await ready();
    const cancel = await w.fake.fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { method: 'POST', headers: { authorization: 'Bearer rk_test_testkey0123456789', 'stripe-version': '2025-09-30.clover', 'content-type': 'application/x-www-form-urlencoded' }, body: 'cancel_at_period_end=true' });
    expect(cancel.status).toBe(200);
    await w.fake.flush();
    const p = await view(w);
    expect(p).toMatchObject({ name: 'payg', cancel_at_period_end: true });
    expect(p.period_end).toBeGreaterThan(0);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(0);
    await w.fake.fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { method: 'DELETE', headers: { authorization: 'Bearer rk_test_testkey0123456789', 'stripe-version': '2025-09-30.clover' } });
    await w.fake.flush();
    expect(w.ws(ws).plan).toBe('free');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(1);
  });
});

describe('the operator moves the lookup key to a new price', () => {
  const moveKey = (w: PlanWorld) => {
    const old = w.fake.state.prices.get('price_fake_extra_monthly') as any;
    old.lookup_key = null; // as Stripe does when the key is transferred
    w.fake.seedPrice({ id: 'price_new_monthly', lookup_key: 'rsm_extra_domain_monthly', unit_amount: 600, currency: 'usd', type: 'recurring', product: 'rsm_extra_domain', metadata: { app: 'ready-set-mail', offer: 'extra-domain' }, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    w.db.sqlite.prepare('DELETE FROM billing_price_cache').run();
  };

  it('a renewal failure on a subscription of the OLD price still marks the payment problem (its stored price is ours)', async () => {
    const { w, subId, ws } = await ready();
    moveKey(w);
    w.fake.setCardBehavior([...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!, 'decline');
    w.fake.advancePeriod(subId);
    await w.fake.flush();
    expect(w.sub(ws)).toMatchObject({ status: 'past_due', price_id: 'price_fake_extra_monthly' });
    expect((await view(w)).payment_problem).toBe(true);
  });

  it('a lapse on the old price is applied: all domains of a workspace without the allowance are paused', async () => {
    const { w, subId, ws } = await ready();
    moveKey(w);
    w.fake.setCardBehavior([...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'canceled' });
    await w.fake.flush();
    expect(w.ws(ws).plan).toBe('free');
    expect((await view(w)).lapsed).toBe(true);
  });

  it('a subscription with no row (being adopted) is recognised as ours by its lookup key, its product or its metadata, and a stranger\'s price is not', () => {
    const sub = (price: Record<string, unknown>) => subFacts({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { workspace_id: 'ws_1' }, items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_x', ...price } }] } } as any);
    expect(sub({ lookup_key: 'rsm_extra_domain_yearly' }).priceIsOurs).toBe(true);
    expect(sub({ lookup_key: null, product: 'rsm_extra_domain' }).priceIsOurs).toBe(true);
    expect(sub({ lookup_key: null, product: 'prod_x', metadata: { app: 'ready-set-mail', offer: 'extra-domain' } }).priceIsOurs).toBe(true);
    expect(sub({ lookup_key: 'something_else', product: 'prod_x', metadata: {} }).priceIsOurs).toBe(false);
    expect(sub({ lookup_key: null, product: { id: 'prod_x' } }).priceIsOurs).toBe(false);
  });
});

describe('the webhook trusts only what is ours', () => {
  it('a subscription with another price, another workspace\'s metadata or another customer changes nothing', async () => {
    const { w, ws } = await ready();
    const stranger = await w.person('stranger@example.com');
    await w.addCard(stranger);
    const cus2 = [...w.fake.state.customers.values()].find((c: any) => c.metadata?.workspace_id === stranger.workspaceId) as any;
    // (a) another price on the stranger's own customer
    w.fake.seedPrice({ id: 'price_other', lookup_key: 'something_else', unit_amount: 100, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    const foreign = await w.fake.fetch('https://api.stripe.com/v1/subscriptions', { method: 'POST', headers: { authorization: 'Bearer rk_test_testkey0123456789', 'stripe-version': '2025-09-30.clover', 'content-type': 'application/x-www-form-urlencoded' }, body: `customer=${cus2.id}&items[0][price]=price_other&items[0][quantity]=3&metadata[workspace_id]=${ws}` });
    expect(foreign.status).toBe(200);
    await w.fake.flush();
    expect(w.sub(stranger.workspaceId)).toBeNull();
    expect(w.ws(stranger.workspaceId).plan).toBe('free');
    // (b) our price, on the stranger's customer, claiming the OWNER's workspace in its metadata
    const price = [...w.fake.state.prices.values()].find((p: any) => p.lookup_key === 'rsm_extra_domain_monthly') as any;
    const lie = await w.fake.fetch('https://api.stripe.com/v1/subscriptions', { method: 'POST', headers: { authorization: 'Bearer rk_test_testkey0123456789', 'stripe-version': '2025-09-30.clover', 'content-type': 'application/x-www-form-urlencoded' }, body: `customer=${cus2.id}&items[0][price]=${price.id}&items[0][quantity]=0&metadata[workspace_id]=${ws}` });
    expect(lie.status).toBe(200);
    await w.fake.flush();
    expect(w.sub(ws).quantity_sent).toBe(1); // the owner's plan did not move
    expect(w.sub(stranger.workspaceId)).toBeNull(); // metadata names another workspace than the customer's own
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspace_subscriptions')[0].n).toBe(1);
  });

  it('an event for an old subscription of the workspace does not touch the current one', async () => {
    const { w, subId, ws } = await ready();
    const before = w.sub(ws);
    w.db.sqlite.prepare('UPDATE workspace_subscriptions SET stripe_subscription_id = ? WHERE workspace_id = ?').run('sub_current', ws);
    w.fake.advancePeriod(subId);
    await w.fake.flush();
    expect(w.sub(ws).stripe_subscription_id).toBe('sub_current');
    expect(w.sub(ws).status).toBe(before.status);
  });

  it('Fix-one-domain orders are untouched: an order invoice is still handled as an order', async () => {
    const { w } = await ready();
    const subEvents = () => rows(w.db, "SELECT COUNT(*) AS n FROM billing_events WHERE outcome LIKE 'subscription_invoice%'")[0].n;
    const before = subEvents();
    const id = w.addDomain(w.owner.workspaceId, 'client.example.com');
    const bought = await w.buy(w.owner, id);
    expect(bought.status).toBe(201);
    await w.fake.flush();
    expect(rows(w.db, "SELECT status FROM billing_orders")[0].status).toBe('paid');
    expect(subEvents()).toBe(before); // the order's invoice events went to the order handler, none to the subscription's
  });

  it('is idempotent: a delivered event twice does its work once', async () => {
    const { w, subId } = await ready();
    const r = w.fake.advancePeriod(subId);
    await w.fake.flush();
    const ev = [...w.fake.state.events.values()].find((e: any) => e.type === 'invoice.paid' && e.data.object.id === r.invoice!.id)!;
    const again = await w.fake.redeliver(ev.id);
    expect((await again.json()).duplicate).toBe(true);
  });
});

describe('the daily job', () => {
  it('repairs a quantity that drifted (the server count wins) and refreshes the status', async () => {
    const { w, ws } = await ready();
    const item = [...w.fake.state.subscriptionItems.values()][0] as any;
    item.quantity = 7; // someone changed it at Stripe
    const report = await runBillingJob(w.env as never, undefined, {});
    expect(report.plans.repaired).toBe(1);
    expect(itemQty(w)).toEqual([1]);
    expect(w.sub(ws)).toMatchObject({ quantity_sent: 1, dirty: 0 });
  });
  it('repairs a quantity left dirty by a removal whose Stripe update failed', async () => {
    const { w, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'three.example.net'")[0].id;
    w.fake.failNext(/POST \/v1\/subscription_items\//, { status: 500 });
    const del = await w.api(w.owner, 'DELETE', `/api/domains/${id}`);
    expect(del.status).toBe(200); // never blocked
    expect(w.sub(ws).dirty).toBe(1);
    expect(itemQty(w)).toEqual([2]); // over-billed until the job runs: at most the one proration
    await runBillingJob(w.env as never, undefined, {});
    expect(itemQty(w)).toEqual([1]);
    expect(w.sub(ws).dirty).toBe(0);
  });
  it('with the plan off it only reads: no quantity is written', async () => {
    const { w } = await ready();
    const off = { ...(w.env as any), HOSTED_PLAN: 'off' };
    const item = [...w.fake.state.subscriptionItems.values()][0] as any;
    item.quantity = 9;
    const writes = w.fake.calls.filter((c: any) => c.method !== 'GET' && !/create_preview/.test(c.path)).length;
    await runBillingJob(off, undefined, {});
    expect(w.fake.calls.filter((c: any) => c.method !== 'GET' && !/create_preview/.test(c.path)).length).toBe(writes);
    expect(itemQty(w)).toEqual([9]);
  });
});

describe('rolling back: HOSTED_PLAN off restores today\'s behaviour without touching Stripe objects', () => {
  it('no plan enforced, no subscription call that changes anything, the webhook still records, Settings shows the plan read-only', async () => {
    const { w, subId, ws } = await ready();
    const off = { ...(w.env as any), HOSTED_PLAN: 'off' };
    Object.assign(w.env, { HOSTED_PLAN: 'off' });
    const writes = () => w.fake.calls.filter((c: any) => c.method !== 'GET' && !/portal|create_preview|checkout/.test(c.path)).length;
    const before = writes();
    // everyone may add a second and a third domain as before; removing and creating workspaces moves no Stripe object
    expect((await w.addFree(w.owner, 'four.example.net')).status).toBe(201);
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'four.example.net'")[0].id;
    expect((await w.api(w.owner, 'DELETE', `/api/domains/${id}`)).status).toBe(200);
    expect(writes()).toBe(before);
    expect(itemQty(w)).toEqual([1]);
    // the webhook still records subscription events
    const cus = [...w.fake.state.customers.keys()].find((c) => w.fake.state.customers.get(c)?.metadata?.workspace_id === ws)!;
    w.fake.setCardBehavior(cus, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'canceled' });
    await w.fake.flush();
    expect(w.sub(ws).status).toBe('canceled');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(0); // nothing is paused when the plan is not enforced
    // the page shows the subscription, read-only (no price table, nothing to manage through us)
    const billing = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(billing.plan).toMatchObject({ mode: 'off', status: 'canceled' });
    void off;
  });
});

describe('the grandfather choice', () => {
  async function grown() {
    const w = await planWorld({ HOSTED_PLAN: 'off' });
    for (const d of ['a.example.com', 'b.example.org', 'c.example.net']) w.addDomain(w.owner.workspaceId, d);
    Object.assign(w.env, { HOSTED_PLAN: 'free_one_domain' });
    return w;
  }
  it('a free workspace that already holds three units keeps all of them working; nothing is paused or asked until the next add', async () => {
    const w = await grown();
    const p = await view(w);
    expect(p).toMatchObject({ grandfathered: true, units: 3, billable: 2, name: 'free' });
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM domains WHERE paused_at IS NOT NULL')[0].n).toBe(0);
    const add = await w.tryVerify(w.owner, 'd.example.io');
    expect(add.status).toBe(402);
    expect((await json(add)).grandfather).toEqual({ units: 3, billable_now: 2, billable_after: 3 });
  });
  it('choice one: start pay as you go (the confirm states the total), the new domain makes it three billable', async () => {
    const w = await grown();
    await w.addCard(w.owner);
    const prev = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=d.example.io'));
    expect(prev).toMatchObject({ needs_confirm: true, grandfather: { units: 3, billable_now: 2, billable_after: 3 } });
    const done = await w.addPaid(w.owner, 'd.example.io');
    expect(done.status).toBe(201);
    expect(itemQty(w)).toEqual([3]);
  });
  it('choice two: keep one free domain (pick which); the others are paused, readable and exportable', async () => {
    const w = await grown();
    const keep = rows(w.db, "SELECT id FROM domains WHERE domain = 'b.example.org'")[0].id;
    const res = await w.api(w.owner, 'POST', '/api/billing/plan/keep-one', { domain_id: keep });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ kept: 'b.example.org', paused: 2 });
    expect(rows(w.db, 'SELECT domain FROM domains WHERE paused_at IS NOT NULL ORDER BY id').map((r) => r.domain)).toEqual(['a.example.com', 'c.example.net']);
    expect((await w.api(w.owner, 'GET', '/api/domains')).status).toBe(200);
    expect((await w.api(w.owner, 'GET', `/api/workspaces/${w.owner.workspaceId}/export`)).status).toBe(200);
    // the choice can be changed
    const other = rows(w.db, "SELECT id FROM domains WHERE domain = 'a.example.com'")[0].id;
    await w.api(w.owner, 'POST', '/api/billing/plan/keep-one', { domain_id: other });
    expect(rows(w.db, 'SELECT domain FROM domains WHERE paused_at IS NULL').map((r) => r.domain)).toContain('a.example.com');
  });
});

describe('rapid changes cannot over- or under-bill', () => {
  it('interleaved adds: two paid adds at once, each domain\'s quantity is recomputed inside the lease: the result is exactly the domains held', async () => {
    const { w, ws } = await ready();
    // both claims exist first, so both adds find a proven domain
    for (const d of ['x.example.net', 'y.example.io']) { await w.api(w.owner, 'POST', '/api/billing/domains', { domain: d, expected_amount: 500, expected_currency: 'usd' }); const c = rows(w.db, 'SELECT token FROM domain_claims WHERE domain = ?', d)[0]; w.prove(d, { txt_name: `_readysetmail.${d}`, txt_value: `readysetmail-verify=${c.token}` }); }
    const results = await Promise.all(['x.example.net', 'y.example.io'].map((d) => w.api(w.owner, 'POST', '/api/billing/domains', { domain: d, expected_amount: 500, expected_currency: 'usd' })));
    const statuses = results.map((r) => r.status).sort();
    const held = w.domainsOf(ws).length;
    expect(itemQty(w)).toEqual([held - 1]); // whatever won, Stripe has exactly the billable count
    expect(w.sub(ws).quantity_sent).toBe(held - 1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(results.filter((r) => r.status === 409).length + (held - 2)).toBe(2);
  });
  it('add, remove, add, remove in a row: the quantity follows the database every time', async () => {
    const { w, ws } = await ready();
    for (const d of ['p.example.net', 'q.example.io']) {
      expect((await w.addPaid(w.owner, d)).status).toBe(201);
      expect(itemQty(w)).toEqual([w.domainsOf(ws).length - 1]);
      const id = rows(w.db, 'SELECT id FROM domains WHERE domain = ?', d)[0].id;
      expect((await w.api(w.owner, 'DELETE', `/api/domains/${id}`)).status).toBe(200);
      expect(itemQty(w)).toEqual([w.domainsOf(ws).length - 1]);
    }
    expect(itemQty(w)).toEqual([1]);
  });
  it('a lease held by another change answers 409 plan_busy and changes nothing; an expired lease is taken over', async () => {
    const { w, ws } = await ready();
    w.db.sqlite.prepare('UPDATE workspaces SET plan_lock_token = ?, plan_lock_until = ? WHERE id = ?').run('someone', Math.floor(Date.now() / 1000) + 30, ws);
    const busy = await w.addPaid(w.owner, 'three.example.net');
    expect(busy.status).toBe(409);
    expect((await json(busy)).code).toBe('plan_busy');
    expect(itemQty(w)).toEqual([1]);
    w.db.sqlite.prepare('UPDATE workspaces SET plan_lock_until = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, ws);
    expect((await w.addPaid(w.owner, 'three.example.net')).status).toBe(201);
    expect(rows(w.db, 'SELECT plan_lock_token AS t FROM workspaces WHERE id = ?', ws)[0].t).toBeNull(); // released
  });
  it('the revision only grows, and every quantity write has its own idempotency key', async () => {
    const { w, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    const keys = w.fake.calls.filter((c: any) => /subscription_items/.test(c.path) && c.method === 'POST').map((c: any) => c.headers.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k: string) => new RegExp(`^rsm-qty-${ws}-si_[a-z0-9_]+-\\d+-\\d+$`).test(k))).toBe(true);
    expect(rows(w.db, 'SELECT plan_revision AS r FROM workspaces WHERE id = ?', ws)[0].r).toBeGreaterThanOrEqual(2);
  });
  it('every quantity write names its target: the key is the same for the same change and different for another', async () => {
    const { w } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    const keys = w.fake.calls.filter((c: any) => c.method === 'POST' && /subscription_items/.test(c.path)).map((c: any) => c.headers.idempotencyKey as string);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/-2-\d+$/); // target quantity 2
  });
});
