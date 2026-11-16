// Buying: the order row first, the Stripe Invoice with idempotent steps, the outcomes, refunds, reconciliation, and the instance owner's list.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { billingWorld, call, json, rows, flushBackground, type World } from './world';
import { runBillingJob } from '../../src/billing/reconcile';
import { CARD_LAST4 } from '../helpers/card-text';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Owner with a card and one domain with something to fix. */
async function ready(kind: 'ok' | 'decline' | 'requires_action' = 'ok') {
  const w = await billingWorld();
  const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
  await w.addCard(w.owner, kind);
  return { w, domainId };
}
const age = (w: World, id: string, seconds: number) => w.db.sqlite.prepare('UPDATE billing_orders SET updated_at = updated_at - ?, created_at = created_at - ? WHERE id = ?').run(seconds, seconds, id);

describe('buying "Fix one domain"', () => {
  it('inserts the order first, charges through an Invoice with idempotent steps, and lets the webhook mark it paid', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const res = await w.buy(w.owner, domainId);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.outcome).toBe('processing');
    expect(body.order).toMatchObject({ domain: 'acme.com', amount: 14900, currency: 'usd', status: 'pending', buyer_email: 'owner@example.com' }); // the answer never says paid
    const id = body.order.id as string;
    expect(id).toMatch(/^ord_[0-9a-f]{32}$/);

    // the Stripe objects
    const posts = w.fake.calls.filter((c) => c.method === 'POST' && /invoice/.test(c.path));
    expect(posts.map((c) => [c.path.replace(/in_[a-z0-9]+/, ':id'), c.headers.idempotencyKey])).toEqual([
      ['/v1/invoices', `rsm-${id}-invoice`], ['/v1/invoiceitems', `rsm-${id}-item`], ['/v1/invoices/:id/finalize', `rsm-${id}-finalize`], ['/v1/invoices/:id/pay', `rsm-${id}-pay`],
    ]);
    expect(w.fake.calls.every((c) => c.headers.stripeVersion === '2025-09-30.clover')).toBe(true);
    const inv = [...w.fake.state.invoices.values()][0];
    expect(inv.metadata).toEqual({ order_id: id, workspace_id: w.owner.workspaceId, domain: 'acme.com', offer: 'fix-one-domain' });
    expect(inv).toMatchObject({ collection_method: 'charge_automatically', auto_advance: false, amount_paid: 14900, currency: 'usd' });
    expect(inv.description).toContain('acme.com');
    expect(posts[3]!.form).toMatchObject({ off_session: 'true' });
    expect([...w.fake.state.invoiceItems.values()][0]).toMatchObject({ invoice: inv.id, price: expect.objectContaining({ id: 'price_fake_fix_one_domain' }) });

    // pending until Stripe says so
    expect(w.order(id)).toMatchObject({ status: 'pending', stripe_invoice_id: inv.id, amount: 14900, stripe_price_id: 'price_fake_fix_one_domain', workspace_name: expect.any(String), domain_name: 'acme.com', domain_id: domainId, paid_at: null });
    expect(w.ownerMails()).toHaveLength(0);

    w.connectWebhook();
    await w.fake.flush(); // signed invoice.paid reaches the Worker
    const paid = w.order(id);
    expect(paid).toMatchObject({ status: 'paid', stripe_charge_id: expect.stringMatching(/^ch_/), stripe_payment_intent_id: expect.stringMatching(/^pi_/), paid_at: expect.any(Number) });
    const shown = await json(await w.api(w.owner, 'GET', `/api/billing/orders/${id}`));
    expect(shown.order).toMatchObject({ status: 'paid' });
    await flushBackground();
    expect(w.audits(w.owner.workspaceId)).toEqual(['billing.card_session_started', 'billing.card_added', 'billing.order_created', 'billing.order_paid']);
  });

  it('emails the instance owner exactly once when it is paid, with the facts and nothing else', async () => {
    const { w, domainId } = await ready();
    const id = (await json(await w.buy(w.owner, domainId))).order.id as string;
    await w.fake.flush();
    const events = [...w.fake.state.events.values()].filter((e) => e.type === 'invoice.paid');
    for (const e of events) await w.fake.redeliver(e.id); // Stripe retries
    for (const e of events) await w.fake.redeliver(e.id);
    const mails = w.ownerMails();
    expect(mails).toHaveLength(1);
    const { subject, text } = mails[0]!;
    expect(subject).toBe('New order: Fix one domain for acme.com');
    for (const fact of [w.owner.workspaceId, 'acme.com', 'owner@example.com', 'USD 149.00', id, w.order(id).stripe_invoice_id]) expect(text).toContain(fact);
    expect(text).not.toMatch(/cus_|pm_/);
    expect(text).not.toMatch(CARD_LAST4);
    expect(w.order(id).owner_notified_at).toBeTruthy();
    // nothing goes to the buyer from here
    const toBuyer = (await import('../auth/helpers')).mailsTo(w.env, 'owner@example.com').filter((m) => /order|invoice|receipt|paid/i.test(m.subject));
    expect(toBuyer).toEqual([]);
  });

  it('needs a card: without one nothing is created', async () => {
    const w = await billingWorld();
    const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
    const res = await w.buy(w.owner, domainId);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('card_required');
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect(w.fake.state.invoices.size).toBe(0);
  });

  it('ignores any price, amount or currency the client sends: the price comes from Stripe', async () => {
    const { w, domainId } = await ready();
    const res = await w.buy(w.owner, domainId, { amount: 1, price: 'price_cheap', price_id: 'price_cheap', unit_amount: 1, currency: 'eur', amount_refunded: 1, status: 'paid', workspace_id: 'ws_x', stripe_invoice_id: 'in_x' });
    expect(res.status).toBe(201);
    const o = rows(w.db, 'SELECT * FROM billing_orders')[0];
    expect(o).toMatchObject({ amount: 14900, currency: 'usd', stripe_price_id: 'price_fake_fix_one_domain', workspace_id: w.owner.workspaceId, status: expect.stringMatching(/pending|paid/) });
    expect(o.amount_refunded).toBe(0);
    expect([...w.fake.state.invoices.values()][0].amount_due).toBe(14900);
  });

  it('an expected_amount that no longer matches Stripe\'s price refuses with 409 and charges nothing', async () => {
    const { w, domainId } = await ready();
    const res = await w.buy(w.owner, domainId, { expected_amount: 9900 });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'price_changed', amount: 14900 });
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect((await w.buy(w.owner, domainId, { expected_amount: 14900 })).status).toBe(201);
  });

  it('validates the request: unknown offer, bad domain id, bad expected_amount', async () => {
    const { w, domainId } = await ready();
    for (const [body, code] of [[{ domain_id: domainId, offer: 'fix-everything' }, 'unknown_offer'], [{ domain_id: 'acme.com', offer: 'fix-one-domain' }, 'invalid_domain'], [{ domain_id: -1, offer: 'fix-one-domain' }, 'invalid_domain'], [{ domain_id: 1.5, offer: 'fix-one-domain' }, 'invalid_domain'], [{ domain_id: domainId, offer: 'fix-one-domain', expected_amount: '149' }, 'invalid_amount']] as const) {
      const res = await w.api(w.owner, 'POST', '/api/billing/orders', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).code).toBe(code);
    }
    expect((await w.api(w.owner, 'POST', '/api/billing/orders', 'not json' as never)).status).toBe(400);
    expect(w.fake.state.invoices.size).toBe(0);
  });

  it('refuses a misconfigured price instead of charging something else', async () => {
    const { w, domainId } = await ready();
    const price = [...w.fake.state.prices.values()][0];
    price.recurring = { interval: 'month' }; price.type = 'recurring';
    const res = await w.buy(w.owner, domainId);
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe('price_misconfigured');
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
  });

  it('only for a live, proven domain of this workspace', async () => {
    const { w } = await ready();
    const evicted = w.addDomain(w.owner.workspaceId, 'gone.com');
    w.db.sqlite.prepare("UPDATE domains SET evicted_at = unixepoch() WHERE id = ?").run(evicted);
    const unproven = w.addDomain(w.owner.workspaceId, 'unproven.com');
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = ?").run(unproven);
    const lost = w.addDomain(w.owner.workspaceId, 'lost.com');
    w.db.sqlite.prepare("UPDATE domains SET proof_lost_at = unixepoch() WHERE id = ?").run(lost);
    const foreign = w.addDomain((await w.person('x@example.com')).workspaceId, 'foreign.com');
    expect((await w.buy(w.owner, evicted)).status).toBe(404);
    expect((await w.buy(w.owner, foreign)).status).toBe(404);
    expect((await w.buy(w.owner, 99999)).status).toBe(404);
    for (const id of [unproven, lost]) {
      const res = await w.buy(w.owner, id);
      expect(res.status).toBe(409);
      expect((await json(res)).code).toBe('domain_unproven');
    }
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
  });
});

describe('one open order per domain, and a double click charges once', () => {
  it('two parallel confirms: one invoice, one charge, one order; the loser gets 409 with the existing order', async () => {
    const { w, domainId } = await ready();
    const [a, b] = await Promise.all([w.buy(w.owner, domainId), w.buy(w.owner, domainId)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = await json(a.status === 201 ? a : b);
    const loser = await json(a.status === 201 ? b : a);
    expect(loser).toMatchObject({ code: 'order_open', order: { id: winner.order.id } });
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(1);
    expect(w.fake.state.invoices.size).toBe(1);
    expect(w.fake.state.charges.size).toBe(1);
    expect(w.fake.calls.filter((c) => c.path.endsWith('/pay')).length).toBe(1);
  });
  it('a second confirm right after the first is refused, and so is one for a paid order', async () => {
    const { w, domainId } = await ready();
    const first = await json(await w.buy(w.owner, domainId));
    const second = await w.buy(w.owner, domainId);
    expect(second.status).toBe(409);
    expect((await json(second)).order.id).toBe(first.order.id);
    await w.fake.flush();
    expect((await w.buy(w.owner, domainId)).status).toBe(409);
    expect(w.fake.state.charges.size).toBe(1);
  });
  it('different domains of one workspace each get their own order', async () => {
    const { w, domainId } = await ready();
    const other = w.addDomain(w.owner.workspaceId, 'second.com');
    expect((await w.buy(w.owner, domainId)).status).toBe(201);
    expect((await w.buy(w.owner, other)).status).toBe(201);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(2);
  });
  it('the database itself enforces the slot: open = pending, paid, started', async () => {
    const { w, domainId } = await ready();
    await w.buy(w.owner, domainId);
    const dup = () => w.db.sqlite.prepare("INSERT INTO billing_orders (id, workspace_id, workspace_name, domain_name, offer, stripe_price_id, amount, currency) VALUES (?, ?, 'W', 'acme.com', 'fix-one-domain', 'p', 1, 'usd')").run(`ord_${'1'.repeat(32)}`, w.owner.workspaceId);
    expect(dup).toThrow(/UNIQUE/);
    w.db.sqlite.prepare("UPDATE billing_orders SET status = 'refunded'").run();
    expect(dup).not.toThrow(); // a closed order frees the slot
  });
  it('a stalled pending order is resumed with the same Stripe objects, not wedged', async () => {
    const { w, domainId } = await ready();
    w.fake.failNext(/\/finalize$/, { status: 500, error: { type: 'api_error', message: 'boom' } });
    const first = await w.buy(w.owner, domainId);
    expect(first.status).toBe(503 === first.status ? 503 : 502);
    expect((await json(first)).order.status).toBe('pending');
    const id = rows(w.db, 'SELECT id FROM billing_orders')[0].id as string;
    expect((await w.buy(w.owner, domainId)).status).toBe(409); // too soon to resume
    age(w, id, 120);
    const again = await w.buy(w.owner, domainId);
    expect(again.status).toBe(201);
    expect((await json(again)).order.id).toBe(id);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(1);
    expect(w.fake.state.invoices.size).toBe(1);
    expect(w.fake.state.charges.size).toBe(1);
  });
});

describe('outcomes', () => {
  it('a declined card: order failed with Stripe\'s words, invoice voided, nothing charged; a new card and a new order work', async () => {
    const { w, domainId } = await ready('decline');
    const res = await w.buy(w.owner, domainId);
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ outcome: 'failed', message: 'Your card was declined.', order: { status: 'failed', failure_message: 'Your card was declined.' } });
    const o = w.order(body.order.id);
    expect(o).toMatchObject({ status: 'failed', failure_code: 'generic_decline', failed_at: expect.any(Number) });
    expect([...w.fake.state.invoices.values()][0].status).toBe('void');
    expect(w.fake.state.charges.size).toBe(0);
    await w.fake.flush();
    expect(w.order(body.order.id).status).toBe('failed'); // the payment_failed event changes nothing further
    expect(w.ownerMails()).toHaveLength(0);
    await flushBackground();
    expect(w.audits(w.owner.workspaceId)).toContain('billing.order_failed');

    await w.addCard(w.owner, 'ok'); // change card
    const retry = await json(await w.buy(w.owner, domainId));
    expect(retry.order.id).not.toBe(body.order.id); // a new order row
    await w.fake.flush();
    expect(w.order(retry.order.id).status).toBe('paid');
    expect(rows(w.db, 'SELECT status FROM billing_orders ORDER BY created_at, rowid').map((r) => r.status)).toEqual(['failed', 'paid']);
  });

  it('a card that needs the bank: the hosted invoice page is offered; completing it there pays the order via the webhook', async () => {
    const { w, domainId } = await ready('requires_action');
    const res = await json(await w.buy(w.owner, domainId));
    expect(res).toMatchObject({ outcome: 'requires_action', action_url: expect.stringContaining('/i/in_'), order: { status: 'pending', action_required: true, action_url: expect.stringContaining('/i/in_') } });
    await w.fake.flush();
    expect(w.order(res.order.id).status).toBe('pending'); // waiting for the bank's confirmation
    const polled = await json(await w.api(w.owner, 'GET', `/api/billing/orders/${res.order.id}`));
    expect(polled.order).toMatchObject({ status: 'pending', action_required: true });
    expect((await w.buy(w.owner, domainId)).status).toBe(409); // not resumed: the buyer is still confirming

    w.fake.completeInvoiceAction([...w.fake.state.invoices.keys()][0]!, 'succeed');
    await w.fake.flush();
    expect(w.order(res.order.id)).toMatchObject({ status: 'paid', note: null });
    expect((await json(await w.api(w.owner, 'GET', `/api/billing/orders/${res.order.id}`))).order).toMatchObject({ status: 'paid', action_required: false, action_url: null });
    expect(w.ownerMails()).toHaveLength(1);
  });

  it('the bank confirmation failing ends the order and voids the invoice, so it can never be paid later', async () => {
    const { w, domainId } = await ready('requires_action');
    const res = await json(await w.buy(w.owner, domainId));
    const invoiceId = [...w.fake.state.invoices.keys()][0]!;
    w.fake.completeInvoiceAction(invoiceId, 'fail');
    await w.fake.flush();
    expect(w.order(res.order.id).status).toBe('failed');
    expect(w.fake.state.invoices.get(invoiceId)!.status).toBe('void');
    // a late success for it is impossible at Stripe and a stale event changes nothing here
    await w.fake.flush();
    expect(w.order(res.order.id).status).toBe('failed');
  });

  it('Stripe being down leaves the order pending and the buyer told to try again; the domain is not charged twice', async () => {
    const { w, domainId } = await ready();
    w.fake.failNext(/\/v1\/invoices$/, { status: 500, error: { type: 'api_error', message: 'internal' } });
    const res = await w.buy(w.owner, domainId);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await json(res)).order.status).toBe('pending');
    expect(w.fake.state.charges.size).toBe(0);
  });

  it('a request Stripe rejects outright ends the order (nothing was charged) instead of leaving it pending', async () => {
    const { w, domainId } = await ready();
    w.fake.failNext(/\/v1\/invoiceitems$/, { status: 400, error: { type: 'invalid_request_error', code: 'parameter_invalid_empty', message: 'secret internals rk_test_leak' } });
    const res = await json(await w.buy(w.owner, domainId));
    expect(res).toMatchObject({ outcome: 'failed', order: { status: 'failed' } });
    expect(JSON.stringify(res)).not.toContain('internals');
    expect(w.fake.state.invoices.size).toBe(0); // a draft is deleted, not voided
  });
});

describe('a domain removed while an order is open', () => {
  it('keeps the order, still shows it, and still processes its payment', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const o = await json(await w.buy(w.owner, domainId));
    const del = await w.api(w.owner, 'DELETE', `/api/domains/${domainId}`);
    expect(del.status).toBe(200);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM domains WHERE id = ?', domainId)[0].n).toBe(0);
    expect(w.order(o.order.id)).toMatchObject({ status: 'pending', domain_name: 'acme.com', domain_id: domainId });
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).orders).toMatchObject([{ id: o.order.id, domain: 'acme.com', status: 'pending' }]);
    await w.fake.flush(); // events were queued with no target: deliver now
    w.connectWebhook();
    await w.fake.flush();
    expect(w.order(o.order.id).status).toBe('paid');
    // the removed name can be added again, but its slot is held by the paid order
    w.addDomain(w.owner.workspaceId, 'acme.com');
    const again = rows(w.db, "SELECT id FROM domains WHERE domain = 'acme.com'")[0].id;
    expect((await w.buy(w.owner, again)).status).toBe(409);
  });
});

describe('refunds', () => {
  it('a partial refund records the amount only; a full one ends the order; late events change nothing', async () => {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    const chargeId = w.order(o.order.id).stripe_charge_id as string;
    w.fake.refund(chargeId, 5000);
    await w.fake.flush();
    expect(w.order(o.order.id)).toMatchObject({ status: 'paid', amount_refunded: 5000, refunded_at: null });
    w.fake.refund(chargeId, 9900);
    await w.fake.flush();
    expect(w.order(o.order.id)).toMatchObject({ status: 'refunded', amount_refunded: 14900, refunded_at: expect.any(Number) });
    await flushBackground();
    expect(w.audits(w.owner.workspaceId)).toContain('billing.order_refunded');
    // out of order: invoice.paid and payment_failed arriving after the refund
    for (const e of [...w.fake.state.events.values()].filter((e) => ['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed'].includes(e.type))) await w.fake.redeliver(e.id);
    const late = w.fake.makeEvent('invoice.paid', { ...[...w.fake.state.invoices.values()][0] });
    expect((await w.sendEvent(late)).status).toBe(200);
    expect(w.order(o.order.id).status).toBe('refunded');
    expect(w.ownerMails()).toHaveLength(1);
    // the domain's slot is free again
    expect(rows(w.db, "SELECT COUNT(*) n FROM billing_orders WHERE status IN ('pending','paid','started')")[0].n).toBe(0);
  });
  it('a refund after the work started or finished moves the order to refunded too', async () => {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    w.db.sqlite.prepare("UPDATE billing_orders SET status = 'done', started_at = 1, done_at = 2").run();
    w.fake.refund(w.order(o.order.id).stripe_charge_id, 14900);
    await w.fake.flush();
    expect(w.order(o.order.id)).toMatchObject({ status: 'refunded', done_at: 2 });
  });
  it('a refund before the paid event was processed catches the order up first', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const o = await json(await w.buy(w.owner, domainId));
    const charge = [...w.fake.state.charges.keys()][0]!;
    const refund = w.fake.makeEvent('charge.refunded', (w.fake.refund(charge, 14900), w.fake.state.charges.get(charge)!));
    expect(w.order(o.order.id).status).toBe('pending');
    expect((await w.sendEvent(refund)).status).toBe(200);
    expect(w.order(o.order.id)).toMatchObject({ status: 'refunded', paid_at: expect.any(Number) });
  });
});

describe('customer.deleted', () => {
  it('clears the workspace\'s customer, keeps its orders, and the next card session gets a fresh customer', async () => {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    const old = rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c as string;
    w.fake.deleteCustomer(old);
    await w.fake.flush();
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBeNull();
    expect(w.order(o.order.id)).toMatchObject({ status: 'paid', stripe_customer_id: old });
    const g = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(g).toMatchObject({ has_customer: false, card: null });
    expect(g.orders).toHaveLength(1);
    expect((await w.buy(w.owner, w.addDomain(w.owner.workspaceId, 'next.com'))).status).toBe(409); // card_required
    const started = await w.api(w.owner, 'POST', '/api/billing/card-session', {});
    expect(started.status).toBe(200);
    const fresh = rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c as string;
    expect(fresh).toMatch(/^cus_/);
    expect(fresh).not.toBe(old);
    expect(w.fake.state.customers.get(fresh)!.deleted).toBeFalsy();
  });
  it('a customer.deleted event for a customer Stripe still has changes nothing (the event body is not trusted)', async () => {
    const { w } = await ready();
    const cust = rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c as string;
    const res = await w.sendEvent(w.fake.makeEvent('customer.deleted', { id: cust, object: 'customer', deleted: true }));
    expect(res.status).toBe(200);
    expect(rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c).toBe(cust);
  });
});

describe('pending orders that never complete are reconciled', () => {
  it('an hour old with an unpaid invoice: voided and canceled by the daily job, freeing the domain', async () => {
    const { w, domainId } = await ready('requires_action');
    const o = await json(await w.buy(w.owner, domainId));
    age(w, o.order.id, 7200);
    const report = await runBillingJob(w.env as never, undefined, {});
    expect(report.reconciled).toBe(1);
    expect(w.order(o.order.id)).toMatchObject({ status: 'canceled', failure_code: 'abandoned' });
    expect([...w.fake.state.invoices.values()][0].status).toBe('void');
    expect((await w.buy(w.owner, domainId)).status).toBe(201);
  });
  it('viewing the order reconciles it too', async () => {
    const { w, domainId } = await ready('requires_action');
    const o = await json(await w.buy(w.owner, domainId));
    age(w, o.order.id, 7200);
    expect((await json(await w.api(w.owner, 'GET', `/api/billing/orders/${o.order.id}`))).order.status).toBe('canceled');
  });
  it('whose invoice was in fact paid (a lost webhook): marked paid and the owner told', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const o = await json(await w.buy(w.owner, domainId));
    expect(w.order(o.order.id).status).toBe('pending');
    age(w, o.order.id, 7200);
    await runBillingJob(w.env as never, undefined, {});
    expect(w.order(o.order.id)).toMatchObject({ status: 'paid' });
    expect(w.ownerMails()).toHaveLength(1);
  });
  it('a recent pending order is left alone', async () => {
    const { w, domainId } = await ready('requires_action');
    const o = await json(await w.buy(w.owner, domainId));
    expect((await runBillingJob(w.env as never, undefined, {})).reconciled).toBe(0);
    expect(w.order(o.order.id).status).toBe('pending');
  });
  it('an order that never got an invoice fails; one whose invoice vanished at Stripe fails', async () => {
    const { w, domainId } = await ready();
    const other = w.addDomain(w.owner.workspaceId, 'second.com');
    w.fake.failNext(/\/v1\/invoices$/, { status: 500, error: { type: 'api_error', message: 'x' } });
    const a = await json(await w.buy(w.owner, domainId));
    w.fake.setWebhookTarget(null);
    const b = await json(await w.buy(w.owner, other));
    w.fake.state.invoices.delete(w.order(b.order.id).stripe_invoice_id);
    const aid = rows(w.db, "SELECT id FROM billing_orders WHERE domain_name = 'acme.com'")[0].id;
    age(w, aid, 7200); age(w, b.order.id, 7200);
    await runBillingJob(w.env as never, undefined, {});
    expect(w.order(aid)).toMatchObject({ status: 'failed', failure_code: 'incomplete' });
    expect(w.order(b.order.id)).toMatchObject({ status: 'failed', failure_code: 'invoice_missing' });
    void a;
  });
  it('retries the owner notice that did not go out, and housekeeps', async () => {
    const { w, domainId } = await ready();
    const mail = (w.env as { SEND_EMAIL: { send: ReturnType<typeof vi.fn> } }).SEND_EMAIL.send;
    const original = mail.getMockImplementation();
    mail.mockImplementation(async (m: { subject: string }) => { if (/New order/.test(m.subject)) throw new Error('provider down'); });
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    expect(w.order(o.order.id)).toMatchObject({ status: 'paid', owner_notified_at: null });
    mail.mockImplementation(original ?? (async () => {}));
    w.db.sqlite.prepare("INSERT INTO billing_events (id, type, received_at) VALUES ('evt_old', 'x', unixepoch() - 100 * 86400)").run();
    w.db.sqlite.prepare("INSERT INTO billing_checkout_sessions (ref, workspace_id, user_id, purpose, return_path, stripe_customer_id, created_at) VALUES ('bcs_old', 'ws', 'u', 'add_card', '/settings', 'cus', unixepoch() - 3 * 86400)").run();
    const report = await runBillingJob(w.env as never, undefined, {});
    expect(report).toMatchObject({ notified: 1, purged_events: 1, purged_sessions: 1 });
    expect(w.order(o.order.id).owner_notified_at).toBeTruthy();
    expect(w.ownerMails()).toHaveLength(2); // one failed attempt, one delivered
  });
  it('deletes only orders older than the seven-year accounting period', async () => {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    w.db.sqlite.prepare("INSERT INTO billing_orders (id, workspace_id, workspace_name, domain_name, offer, stripe_price_id, amount, currency, status, created_at) VALUES ('ord_" + 'a'.repeat(32) + "', 'ws_gone', 'Gone', 'old.com', 'fix-one-domain', 'p', 14900, 'usd', 'done', unixepoch() - 8 * 365 * 86400)").run();
    expect((await runBillingJob(w.env as never, undefined, {})).purged_orders).toBe(1);
    expect(rows(w.db, 'SELECT id FROM billing_orders').map((r) => r.id)).toEqual([o.order.id]);
  });
  it('does nothing when billing is off', async () => {
    const w = await billingWorld({}, { stripe: false });
    expect(await runBillingJob(w.env as never)).toEqual({ reconciled: 0, failed: 0, notified: 0, purged_events: 0, purged_sessions: 0, purged_orders: 0 });
  });
});

describe('the instance owner\'s orders', () => {
  async function paidOrder() {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    return { w, id: o.order.id as string };
  }
  it('lists orders of every workspace for the instance owner only', async () => {
    const { w, id } = await paidOrder();
    const other = await w.person('other@example.com');
    const second = w.addDomain(other.workspaceId, 'other.org');
    await w.addCard(other);
    await w.buy(other, second);
    await w.fake.flush();
    const list = await json(await w.api(w.operator, 'GET', '/api/operator/orders'));
    expect(list.orders).toHaveLength(2);
    expect(list.orders.find((o: any) => o.id === id)).toMatchObject({ workspace_id: w.owner.workspaceId, domain: 'acme.com', buyer_email: 'owner@example.com', amount: 14900, status: 'paid', next: 'started', stripe_invoice_id: expect.stringMatching(/^in_/) });
    expect((await json(await w.api(w.operator, 'GET', '/api/operator/orders?status=done'))).orders).toEqual([]);
    for (const p of [w.owner, other]) {
      const res = await w.api(p, 'GET', '/api/operator/orders');
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe('operator_required');
      expect((await w.api(p, 'POST', `/api/operator/orders/${id}/started`, {})).status).toBe(403);
    }
    expect(w.order(id).status).toBe('paid');
  });
  it('marks started then done, validated and audited, and offers no refund', async () => {
    const { w, id } = await paidOrder();
    expect((await w.api(w.operator, 'POST', `/api/operator/orders/${id}/done`, {})).status).toBe(409); // paid → done is not a move
    const started = await w.api(w.operator, 'POST', `/api/operator/orders/${id}/started`, {});
    expect(started.status).toBe(200);
    expect((await json(started)).order).toMatchObject({ status: 'started', next: 'done' });
    expect((await w.api(w.operator, 'POST', `/api/operator/orders/${id}/started`, {})).status).toBe(409);
    const done = await json(await w.api(w.operator, 'POST', `/api/operator/orders/${id}/done`, {}));
    expect(done.order).toMatchObject({ status: 'done', next: null });
    expect(w.order(id)).toMatchObject({ status: 'done', started_at: expect.any(Number), done_at: expect.any(Number) });
    expect((await w.api(w.operator, 'POST', `/api/operator/orders/${id}/started`, {})).status).toBe(409);
    await flushBackground();
    const audit = rows(w.db, "SELECT action, actor_type, actor_email FROM audit_log WHERE workspace_id = ? AND action IN ('billing.order_started','billing.order_done') ORDER BY id", w.owner.workspaceId);
    expect(audit).toEqual([{ action: 'billing.order_started', actor_type: 'user', actor_email: 'operator@example.com' }, { action: 'billing.order_done', actor_type: 'user', actor_email: 'operator@example.com' }]);
    for (const path of [`/api/operator/orders/${id}/refund`, `/api/operator/orders/${id}/refunded`, `/api/operator/orders/${id}`]) expect([404, 405]).toContain((await w.api(w.operator, 'POST', path, {})).status);
    expect(w.fake.calls.filter((c) => /refund/.test(c.path))).toEqual([]);
    expect((await w.api(w.operator, 'POST', `/api/operator/orders/ord_${'0'.repeat(32)}/started`, {})).status).toBe(404);
  });
  it('without OWNER_EMAIL nobody is the instance owner of the hosted service', async () => {
    const w = await billingWorld({ OWNER_EMAIL: undefined });
    expect((await w.api(w.operator, 'GET', '/api/operator/orders')).status).toBe(403);
    expect((await w.api(w.owner, 'GET', '/api/operator/orders')).status).toBe(403);
  });
  it('the order is not visible to its buyer as anything but their own order view', async () => {
    const { w, id } = await paidOrder();
    const mine = await json(await w.api(w.owner, 'GET', `/api/billing/orders/${id}`));
    expect(Object.keys(mine.order)).not.toContain('workspace_id');
    expect(JSON.stringify(mine)).not.toMatch(/\b(in|ch|pi|cus|price)_[a-z0-9]/);
  });
});

describe('workspace deletion and export', () => {
  it('keeps the orders (accounting), drops the checkout bindings, leaves the Stripe customer, and exports orders', async () => {
    const { w, domainId } = await ready();
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    const exported = await json(await w.api(w.owner, 'GET', `/api/workspaces/${w.owner.workspaceId}/export`));
    expect(exported.workspace).toMatchObject({ id: w.owner.workspaceId, stripe_customer_id: expect.stringMatching(/^cus_/) });
    expect(exported.billing_orders).toHaveLength(1);
    expect(exported.billing_orders[0]).toMatchObject({ id: o.order.id, domain_name: 'acme.com', amount: 14900, currency: 'usd', status: 'paid', buyer_email: 'owner@example.com' });

    const second = await json(await call(w.env, 'POST', '/api/workspaces', { key: w.owner.token, body: { name: 'Second' } }));
    const customers = w.fake.state.customers.size;
    const name = rows(w.db, 'SELECT name FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].name as string;
    const del = await call(w.env, 'DELETE', `/api/workspaces/${w.owner.workspaceId}?confirm=${encodeURIComponent(name)}`, { key: w.owner.token, headers: w.h(w.owner) });
    expect(del.status, await del.clone().text()).toBe(200);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].n).toBe(0);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_checkout_sessions WHERE workspace_id = ?', w.owner.workspaceId)[0].n).toBe(0);
    expect(rows(w.db, 'SELECT id, workspace_id, workspace_name, domain_name, buyer_email, amount, status FROM billing_orders')).toEqual([
      { id: o.order.id, workspace_id: w.owner.workspaceId, workspace_name: name, domain_name: 'acme.com', buyer_email: 'owner@example.com', amount: 14900, status: 'paid' },
    ]);
    expect(w.fake.state.customers.size).toBe(customers); // the customer is not deleted by us
    expect(w.fake.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    // the instance owner still sees it
    expect((await json(await w.api(w.operator, 'GET', '/api/operator/orders'))).orders[0]).toMatchObject({ id: o.order.id, workspace_name: name });
    void second;
  });
});
