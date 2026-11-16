// The first payment of a new subscription (docs/billing.md): charged NOW, by Stripe's own preview amount; declined → nothing added, nothing left at Stripe;
// waiting on the bank → the domain is visibly pending until Stripe says paid; never paid → the domain goes again and the owner is told once.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, type PlanWorld } from './world';

afterEach(() => vi.unstubAllGlobals());
const subs = (w: PlanWorld) => [...w.fake.state.subscriptions.values()] as any[];
const pend = (w: PlanWorld) => rows(w.db, 'SELECT domain FROM domains WHERE payment_pending_at IS NOT NULL ORDER BY id').map((r) => r.domain);
const billing = async (w: PlanWorld) => (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;

async function withFree(card: 'ok' | 'decline' | 'requires_action') {
  const w = await planWorld();
  await w.addFree(w.owner, 'one.example.com');
  await w.addCard(w.owner, card);
  return w;
}

describe('no subscription yet: the add creates it and the first invoice is charged now', () => {
  it('paid: the subscription starts at the quantity owed, with the amount Stripe previewed; no quantity update follows', async () => {
    const w = await withFree('ok');
    const res = await w.addPaid(w.owner, 'two.example.org');
    expect(res.status).toBe(201);
    expect((await json(res)).payment).toBeNull();
    const [sub] = subs(w);
    expect(sub.status).toBe('active');
    expect([...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity)).toEqual([1]);
    const invoice = [...w.fake.state.invoices.values()].find((i: any) => i.billing_reason === 'subscription_create') as any;
    expect(invoice).toMatchObject({ status: 'paid', amount_paid: 500 });
    expect(w.fake.calls.some((c: any) => /subscription_items/.test(c.path) && c.method === 'POST')).toBe(false);
    expect(w.fake.calls.find((c: any) => c.path === '/v1/subscriptions')?.form.payment_behavior).toBe('allow_incomplete');
    expect(w.ws(w.owner.workspaceId).plan).toBe('payg');
    expect(pend(w)).toEqual([]);
  });

  it('the confirm must echo the amount it showed: no echo, or another amount, charges nothing and adds nothing', async () => {
    const w = await withFree('ok');
    const noEcho = await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' });
    expect(noEcho.status).toBe(409);
    expect(await json(noEcho)).toMatchObject({ code: 'price_changed', charge_now: 500 });
    const wrong = await w.addPaid(w.owner, 'two.example.org', { expected_charge: 100 });
    expect(wrong.status).toBe(409);
    expect(subs(w)).toEqual([]);
    expect(w.fake.state.invoices.size).toBe(0);
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
  });

  it('declined: the incomplete subscription is cancelled, the domain is rolled back, the answer says what to do', async () => {
    const w = await withFree('decline');
    const res = await w.addPaid(w.owner, 'two.example.org');
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ code: 'payment_failed', error: 'Your card was declined. Use another card.', action: 'update_card' });
    expect(subs(w).map((s) => s.status)).toEqual(['canceled']);
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
    expect(w.sub(w.owner.workspaceId)).toBeNull();
    expect(w.ws(w.owner.workspaceId).plan).toBe('free');
    await w.fake.flush(); // the cancelled subscription's event finds no row: nothing happens
    expect(w.sub(w.owner.workspaceId)).toBeNull();
    // another card, and it works
    await w.addCard(w.owner, 'ok');
    expect((await w.addPaid(w.owner, 'two.example.org')).status).toBe(201);
  });

  it('waiting on the bank: the domain is there and visibly pending, with the hosted invoice link; nothing else can be added meanwhile', async () => {
    const w = await withFree('requires_action');
    const res = await w.addPaid(w.owner, 'two.example.org');
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.added.map((a: any) => a.domain)).toEqual(['two.example.org']);
    expect(body.payment).toMatchObject({ state: 'requires_action', action_url: expect.stringMatching(/^https:\/\/stripe\.fake\/i\/in_/) });
    expect(pend(w)).toEqual(['two.example.org']);
    const p = await billing(w);
    expect(p.pending).toEqual({ domains: ['two.example.org'], action_url: body.payment.action_url });
    expect(p.name).toBe('free'); // the plan has not started
    const again = await w.addPaid(w.owner, 'three.example.net');
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'payment_pending', error: "Waiting for your bank's confirmation." });
    expect(w.domainsOf(w.owner.workspaceId)).not.toContain('three.example.net');
  });

  it('the bank confirms: invoice.paid makes the plan start and the domain ordinary; the confirm sees it by polling', async () => {
    const w = await withFree('requires_action');
    await w.addPaid(w.owner, 'two.example.org');
    const inv = [...w.fake.state.invoices.values()].find((i: any) => i.billing_reason === 'subscription_create') as any;
    w.fake.completeInvoiceAction(inv.id, 'succeed');
    await w.fake.flush();
    expect(pend(w)).toEqual([]);
    expect(w.ws(w.owner.workspaceId).plan).toBe('payg');
    expect(w.sub(w.owner.workspaceId)).toMatchObject({ status: 'active', quantity_sent: 1, action_url: null });
    const p = await billing(w);
    expect(p).toMatchObject({ pending: null, name: 'payg', billable: 1 });
  });

  it('the poll asks Stripe again when the webhook was lost', async () => {
    const w = await withFree('requires_action');
    await w.addPaid(w.owner, 'two.example.org');
    w.fake.setWebhookTarget(null); // every event from here is lost
    const inv = [...w.fake.state.invoices.values()].find((i: any) => i.billing_reason === 'subscription_create') as any;
    w.fake.completeInvoiceAction(inv.id, 'succeed');
    const p = await billing(w); // the owner's confirm polls GET /api/billing
    expect(p.pending).toBeNull();
    expect(pend(w)).toEqual([]);
  });

  it('never paid: the pending domain is removed again, the plan never started, and the owner is told once', async () => {
    const w = await withFree('requires_action');
    await w.addPaid(w.owner, 'two.example.org');
    const sub = subs(w)[0];
    sub.status = 'incomplete_expired'; // Stripe gives up after a day
    const p = await billing(w);
    expect(p.notice).toBe('payment_not_completed');
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
    expect(w.sub(w.owner.workspaceId)).toBeNull();
    expect(w.ws(w.owner.workspaceId).plan).toBe('free');
    expect((await billing(w)).notice).toBeNull(); // once
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'domain.add_rolled_back'")[0].n).toBe(1);
    await w.addCard(w.owner, 'ok');
    expect((await w.addPaid(w.owner, 'two.example.org')).status).toBe(201);
  });
});

describe('a workspace that already has its subscription (quantity 0 or more)', () => {
  it('a card-first workspace has its quantity-0 subscription: its first domain raises the quantity, nothing is charged at the click', async () => {
    const w = await planWorld();
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Client' });
    expect(start.status).toBe(200);
    const sessionId = (await json(start)).url.split('/pay/')[1];
    await (await import('../auth/helpers')).call(w.env, 'GET', w.fake.completeCheckout(sessionId, { card: 'ok' }).replace(/^https?:\/\/[^/]+/, ''), { key: w.owner.token });
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'Client'")[0].id as string;
    const p = { ...w.owner, workspaceId: id };
    const invoicesBefore = [...w.fake.state.invoices.values()].filter((i: any) => i.amount_paid > 0).length;
    const prev = await json(await w.api(p, 'GET', '/api/billing/domains/preview?domain=client.example.com'));
    expect(prev).toMatchObject({ plan_starts: false, charge_now: 0, next_invoice: { currency: 'usd' } });
    expect((await w.addPaid(p, 'client.example.com')).status).toBe(201);
    expect([...w.fake.state.invoices.values()].filter((i: any) => i.amount_paid > 0).length).toBe(invoicesBefore); // nothing charged at the click
    expect(w.sub(id).quantity_sent).toBe(1);
  });
});

describe('the explicit start', () => {
  it('an ordinary workspace: a subscription at quantity 0, no charge', async () => {
    const w = await planWorld();
    await w.addCard(w.owner);
    const res = await w.api(w.owner, 'POST', '/api/billing/plan/start', {});
    expect(res.status).toBe(201);
    expect((await json(res)).payment).toBeNull();
    expect(w.sub(w.owner.workspaceId)).toMatchObject({ status: 'active', quantity_sent: 0 });
    expect([...w.fake.state.invoices.values()].every((i: any) => (i.amount_paid ?? 0) === 0)).toBe(true);
  });
  it('a grandfathered workspace: the first invoice for what it already holds is charged now, by the amount shown; a card that needs the bank leaves them pending, not a 402 without a link', async () => {
    const w = await planWorld({ HOSTED_PLAN: 'off' });
    for (const d of ['a.example.com', 'b.example.org', 'c.example.net']) w.addDomain(w.owner.workspaceId, d);
    Object.assign(w.env, { HOSTED_PLAN: 'free_one_domain' });
    await w.addCard(w.owner, 'requires_action');
    const prev = await json(await w.api(w.owner, 'GET', '/api/billing/domains/preview?start=1'));
    expect(prev).toMatchObject({ plan_starts: true, charge_now: 1000, grandfather: { units: 3, billable_now: 2 } });
    const wrong = await w.api(w.owner, 'POST', '/api/billing/plan/start', { expected_charge: 500 });
    expect(wrong.status).toBe(409);
    const res = await w.api(w.owner, 'POST', '/api/billing/plan/start', { expected_charge: 1000 });
    expect(res.status).toBe(201);
    expect((await json(res)).payment).toMatchObject({ state: 'requires_action', action_url: expect.stringMatching(/^https:\/\//) });
    expect(w.sub(w.owner.workspaceId).status).toBe('incomplete');
    const inv = [...w.fake.state.invoices.values()][0] as any;
    w.fake.completeInvoiceAction(inv.id, 'succeed');
    await w.fake.flush();
    expect(w.sub(w.owner.workspaceId)).toMatchObject({ status: 'active', quantity_sent: 2 });
    expect(w.ws(w.owner.workspaceId).plan).toBe('payg');
  });
});

describe('after a lapse a workspace that does not hold the free domain has every domain paused', () => {
  it('the Billing page says so with the one action', async () => {
    const w = await planWorld();
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'NoAllowance' });
    w.fake.completeCheckout((await json(start)).url.split('/pay/')[1], { card: 'ok' });
    await w.fake.flush();
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'NoAllowance'")[0].id as string;
    const p = { ...w.owner, workspaceId: id };
    await w.addPaid(p, 'client.example.com');
    const subId = subs(w).find((s) => s.metadata.workspace_id === id).id;
    const cus = [...w.fake.state.customers.keys()].find((c) => w.fake.state.customers.get(c)?.metadata?.workspace_id === id)!;
    w.fake.setCardBehavior(cus, 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'canceled' });
    await w.fake.flush();
    const view = (await json(await w.api(p, 'GET', '/api/billing'))).plan;
    expect(view).toMatchObject({ lapsed: true, paused_domains: 1, resume_by_starting: true, includes_free_domain: false });
  });
});
