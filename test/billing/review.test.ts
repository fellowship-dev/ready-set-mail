// PR 175 review fixes: 3-D Secure, paid-with-a-different-amount, the price the buyer saw, who sees the card, payments for closed orders, and the draft-invoice check.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { billingWorld, json, rows, flushBackground, type World } from './world';
import { runBillingJob } from '../../src/billing/reconcile';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function ready(kind: 'ok' | 'decline' | 'requires_action' = 'ok') {
  const w = await billingWorld();
  const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
  await w.addCard(w.owner, kind);
  return { w, domainId };
}
const customerOf = (w: World) => rows(w.db, 'SELECT stripe_customer_id c FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].c as string;
const firstInvoice = (w: World) => [...w.fake.state.invoices.values()][0]!;
const eventOf = (w: World, type: string) => [...w.fake.state.events.values()].find((e) => e.type === type)!;
const age = (w: World, id: string, seconds: number) => w.db.sqlite.prepare('UPDATE billing_orders SET updated_at = updated_at - ?, created_at = created_at - ? WHERE id = ?').run(seconds, seconds, id);

describe('1. 3-D Secure: invoice.payment_failed while the buyer still has to confirm', () => {
  it('keeps the order pending (action required) and the invoice open, whichever event arrives first, and finishing on the hosted page pays it', async () => {
    for (const order of ['action_required first', 'payment_failed first'] as const) {
      const { w, domainId } = await ready('requires_action');
      w.fake.autoDeliver = false; // the test decides the order of arrival
      const res = await json(await w.buy(w.owner, domainId));
      expect(res.outcome, order).toBe('requires_action');
      const inv = firstInvoice(w);
      const types = [...w.fake.state.events.values()].map((e) => e.type);
      expect(types, 'the fake sends both events in its 3DS path').toEqual(expect.arrayContaining(['invoice.payment_action_required', 'invoice.payment_failed']));
      const pair = [eventOf(w, 'invoice.payment_action_required'), eventOf(w, 'invoice.payment_failed')];
      if (order === 'payment_failed first') pair.reverse();
      for (const e of pair) expect((await w.fake.deliver(e)).status, order).toBe(200);

      expect(w.order(res.order.id), order).toMatchObject({ status: 'pending', note: 'action_required', failure_code: null });
      expect(w.fake.state.invoices.get(inv.id)!.status, order).toBe('open'); // not voided
      expect((await json(await w.api(w.owner, 'GET', `/api/billing/orders/${res.order.id}`))).order, order).toMatchObject({ status: 'pending', action_required: true, action_url: expect.stringContaining(inv.id) });

      w.fake.completeInvoiceAction(inv.id, 'succeed'); // the buyer finishes on the hosted invoice page
      w.connectWebhook();
      await w.fake.flush();
      expect(w.order(res.order.id), order).toMatchObject({ status: 'paid', failure_code: null });
      expect(w.ownerMails(), order).toHaveLength(1);
    }
  });

  it('a PaymentIntent that is still processing or requires confirmation also stays pending', async () => {
    for (const status of ['processing', 'requires_confirmation'] as const) {
      const { w, domainId } = await ready('requires_action');
      w.fake.autoDeliver = false;
      const res = await json(await w.buy(w.owner, domainId));
      const inv = firstInvoice(w);
      w.fake.state.paymentIntents.get(inv.payments[0].payment.payment_intent)!.status = status;
      await w.fake.deliver(eventOf(w, 'invoice.payment_failed'));
      expect(w.order(res.order.id), status).toMatchObject({ status: 'pending', note: 'action_required' });
      expect(w.fake.state.invoices.get(inv.id)!.status, status).toBe('open');
    }
  });

  it('abandoning or failing the bank step is a terminal failure: failed and voided', async () => {
    const { w, domainId } = await ready('requires_action');
    const res = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    expect(w.order(res.order.id).status).toBe('pending');
    const inv = firstInvoice(w);
    w.fake.completeInvoiceAction(inv.id, 'fail'); // PaymentIntent back to requires_payment_method + invoice.payment_failed
    await w.fake.flush();
    expect(w.order(res.order.id)).toMatchObject({ status: 'failed', failure_code: 'payment_intent_authentication_failure', failure_message: 'Your bank did not confirm the payment. You have not been charged. Try again or use another card.' });
    expect(w.fake.state.invoices.get(inv.id)!.status).toBe('void');
  });
});

describe('2. a paid invoice for our line with a different amount_paid', () => {
  it('a customer credit balance: the order is paid, amount_paid is recorded, the operator gets the normal notice and nobody an alert', async () => {
    const { w, domainId } = await ready();
    w.fake.setCustomerBalance(customerOf(w), -900);
    const res = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    expect(firstInvoice(w)).toMatchObject({ status: 'paid', amount_paid: 14000 });
    expect(w.order(res.order.id)).toMatchObject({ status: 'paid', amount: 14900, amount_paid: 14000, paid_at: expect.any(Number) });
    expect(w.ownerMails()).toHaveLength(1);
    expect(w.ownerMails()[0]!.text).toContain('USD 140.00'); // what was collected
    expect(w.alertMails()).toHaveLength(0);
    const shown = (await json(await w.api(w.owner, 'GET', `/api/billing/orders/${res.order.id}`))).order;
    expect(shown).toMatchObject({ status: 'paid', amount: 14900, amount_paid: 14000 });
  });

  it('a credit that covers it all (amount_paid 0) is paid too', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const res = await json(await w.buy(w.owner, domainId));
    firstInvoice(w).amount_paid = 0;
    w.connectWebhook();
    await w.fake.flush();
    expect(w.order(res.order.id)).toMatchObject({ status: 'paid', amount_paid: 0 });
  });

  const wrong: Array<[string, (w: World) => void]> = [
    ['another price', (w) => { [...w.fake.state.invoiceItems.values()][0]!.price.id = 'price_other'; }],
    ['an extra line', (w) => { const it = [...w.fake.state.invoiceItems.values()][0]!; w.fake.state.invoiceItems.set('ii_extra', { ...structuredClone(it), id: 'ii_extra' }); }],
    ['quantity 2', (w) => { [...w.fake.state.invoiceItems.values()][0]!.quantity = 2; }],
    ['another currency', (w) => { firstInvoice(w).currency = 'eur'; [...w.fake.state.invoiceItems.values()][0]!.currency = 'eur'; }],
  ];
  for (const [name, mutate] of wrong) {
    it(`a real mismatch (${name}): logged as an error, the operator is emailed once, the order is not marked paid, the buyer is never told "not charged"`, async () => {
      const { w, domainId } = await ready();
      const err = vi.mocked(console.error);
      w.fake.setWebhookTarget(null);
      const res = await json(await w.buy(w.owner, domainId));
      mutate(w);
      w.connectWebhook();
      await w.fake.flush();
      const id = res.order.id as string;
      expect(w.order(id).status).toBe('pending');
      expect(w.ownerMails()).toHaveLength(0);
      expect(w.alertMails()).toHaveLength(1);
      expect(w.alertMails()[0]!.text).toContain(id);
      expect(w.alertMails()[0]!.text).toContain(w.order(id).stripe_invoice_id);
      expect(err.mock.calls.some((c) => String(c[0]).includes(id))).toBe(true);
      // seen again (a retry, the daily job): still one email
      for (const e of [...w.fake.state.events.values()].filter((x) => x.type === 'invoice.paid')) await w.fake.redeliver(e.id);
      age(w, id, 7200);
      await runBillingJob(w.env as never);
      expect(w.alertMails()).toHaveLength(1);
      const shown = JSON.stringify((await json(await w.api(w.owner, 'GET', `/api/billing/orders/${id}`))).order);
      expect(shown).not.toMatch(/not been charged/i);
      expect(JSON.parse(shown)).toMatchObject({ status: 'pending', payment_review: true });
    });
  }

  it('a paid invoice of another customer (met by the daily job) is a mismatch that is reported', async () => {
    const { w, domainId } = await ready();
    w.fake.setWebhookTarget(null);
    const res = await json(await w.buy(w.owner, domainId));
    firstInvoice(w).customer = 'cus_someone_else';
    age(w, res.order.id, 7200);
    await runBillingJob(w.env as never);
    expect(w.order(res.order.id).status).toBe('pending');
    expect(w.alertMails()).toHaveLength(1);
  });
});

describe('3. expected_amount and expected_currency are required', () => {
  it('missing either is a 400 and creates nothing', async () => {
    const { w, domainId } = await ready();
    for (const body of [{ expected_currency: 'usd' }, { expected_amount: 14900 }, {}, { expected_amount: '14900', expected_currency: 'usd' }, { expected_amount: 14900, expected_currency: 5 }, { expected_amount: 14900, expected_currency: '' }]) {
      const r = await w.api(w.owner, 'POST', '/api/billing/orders', { domain_id: domainId, offer: 'fix-one-domain', ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect(w.fake.calls.filter((c) => c.path.startsWith('/v1/invoice'))).toHaveLength(0);
  });

  it('a mismatch with the fresh Stripe price is a 409 price_changed carrying the new amount and currency, and nothing is charged', async () => {
    const { w, domainId } = await ready();
    w.fake.seedPrice({ id: 'price_fake_fix_one_domain', active: false, lookup_key: null });
    w.fake.seedPrice({ id: 'price_new', lookup_key: 'rsm_fix_one_domain', unit_amount: 99900, currency: 'usd', type: 'one_time', active: true, billing_scheme: 'per_unit' });
    const r = await w.buy(w.owner, domainId, { expected_amount: 14900, expected_currency: 'usd' });
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ code: 'price_changed', amount: 99900, currency: 'usd' });
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(0);
    expect(w.fake.state.invoices.size).toBe(0);
    // the same amount in another currency is a different price too
    w.fake.seedPrice({ id: 'price_new', unit_amount: 14900 });
    const r2 = await w.buy(w.owner, domainId, { expected_amount: 14900, expected_currency: 'eur' });
    expect(r2.status).toBe(409);
    expect(await json(r2)).toMatchObject({ code: 'price_changed', amount: 14900, currency: 'usd' });
    // what they now see is what they are charged (the currency in any letter case)
    const ok = await w.buy(w.owner, domainId, { expected_amount: 14900, expected_currency: 'USD' });
    expect(ok.status).toBe(201);
  });
});

describe('4. only the owner sees the card and the billing email', () => {
  it('admins and members get card_on_file and the order states on GET /api/billing and GET /api/billing/domains/:id; the owner keeps the full view', async () => {
    const { w, domainId } = await ready();
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const member = await w.addMember(w.owner.workspaceId, 'member@example.com', 'member');
    for (const path of ['/api/billing', `/api/billing/domains/${domainId}`]) {
      const o = await json(await w.api(w.owner, 'GET', path));
      expect(o, path).toMatchObject({ card_on_file: true, card: { brand: 'visa', last4: '4242', exp_month: 12 }, billing_email: 'owner@example.com' });
      for (const who of [admin, member]) {
        const res = await w.api(who, 'GET', path);
        const text = await res.text();
        expect(res.status, path).toBe(200);
        const b = JSON.parse(text);
        expect(b.card_on_file, path).toBe(true);
        expect(b, path).not.toHaveProperty('card');
        expect(b, path).not.toHaveProperty('billing_email');
        expect(text, path).not.toMatch(/4242|visa|owner@example\.com/i);
        expect(b.orders, path).toBeInstanceOf(Array);
        expect(b.can_manage ?? b.can_buy, path).toBe(false);
      }
    }
  });

  it('card_on_file is false when there is no card, for every role', async () => {
    const w = await billingWorld();
    const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
    const member = await w.addMember(w.owner.workspaceId, 'member@example.com', 'member');
    expect((await json(await w.api(member, 'GET', '/api/billing'))).card_on_file).toBe(false);
    expect((await json(await w.api(w.owner, 'GET', `/api/billing/domains/${domainId}`))).card_on_file).toBe(false);
  });
});

describe('6. a payment for an order that is already closed', () => {
  it('emails the operator once (and says so truthfully to the buyer)', async () => {
    const { w, domainId } = await ready('decline');
    const res = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    const id = res.order.id as string;
    expect(w.order(id).status).toBe('failed');
    // the invoice is paid after all (a payment that arrived late)
    const inv = firstInvoice(w);
    inv.status = 'paid'; inv.amount_paid = inv.amount_due;
    const ev = w.fake.makeEvent('invoice.paid', inv);
    expect((await w.sendEvent(ev)).status).toBe(200);
    expect(w.order(id).status).toBe('failed');
    expect(w.alertMails()).toHaveLength(1);
    expect(w.alertMails()[0]!.text).toContain(id);
    await w.sendEvent(w.fake.makeEvent('invoice.paid', inv));
    await w.sendEvent(w.fake.makeEvent('invoice.payment_succeeded', inv));
    expect(w.alertMails()).toHaveLength(1);
    expect(w.ownerMails()).toHaveLength(0); // it was never "paid" as an order
    expect(w.order(id).failure_message).not.toMatch(/not been charged/i);
    await flushBackground();
  });
});

describe('7. the draft invoice is checked before it is finalized', () => {
  /** Run `change` between adding the invoice item and finalizing (the fake's answer to POST /v1/invoiceitems). */
  function afterItem(w: World, change: () => void) {
    const real = w.fake.fetch.bind(w.fake);
    w.fake.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (String(input).endsWith('/v1/invoiceitems') && init?.method === 'POST') change();
      return res;
    };
  }
  const cases: Array<[string, (w: World) => void]> = [
    ['the price moved between the steps', (w) => { w.fake.seedPrice({ id: 'price_fake_fix_one_domain', unit_amount: 99900 }); [...w.fake.state.invoiceItems.values()][0]!.amount = 99900; firstInvoice(w).total = 99900; firstInvoice(w).amount_due = 99900; }],
    ['an extra line appeared', (w) => { const it = [...w.fake.state.invoiceItems.values()][0]!; w.fake.state.invoiceItems.set('ii_extra', { ...structuredClone(it), id: 'ii_extra' }); }],
    ['the line is not our price', (w) => { [...w.fake.state.invoiceItems.values()][0]!.price.id = 'price_other'; }],
  ];
  for (const [name, change] of cases) {
    it(`${name}: the draft is deleted, nothing is finalized or charged, the order fails cleanly`, async () => {
      const { w, domainId } = await ready();
      afterItem(w, () => change(w));
      const res = await w.buy(w.owner, domainId);
      const body = await json(res);
      expect(body.outcome).toBe('failed');
      expect(body.message).toBe('We could not start the payment. You have not been charged.');
      expect(w.order(body.order.id)).toMatchObject({ status: 'failed', failure_code: 'invoice_mismatch', failure_message: 'We could not start the payment. You have not been charged.' });
      expect(w.fake.state.invoices.size).toBe(0); // deleted
      expect([...w.fake.state.invoiceItems.values()].filter((i) => i.invoice)).toHaveLength(0);
      const paths = w.fake.calls.map((c) => `${c.method} ${c.path}`);
      expect(paths.some((p) => /finalize|\/pay/.test(p))).toBe(false);
      expect(w.fake.state.charges.size).toBe(0);
      // the buyer can try again with a new order
      expect(rows(w.db, 'SELECT status FROM billing_orders').map((r) => r.status)).toEqual(['failed']);
    });
  }

  it('a normal order is untouched by the check', async () => {
    const { w, domainId } = await ready();
    const body = await json(await w.buy(w.owner, domainId));
    expect(body.outcome).toBe('processing');
    await w.fake.flush();
    expect(w.order(body.order.id).status).toBe('paid');
  });
});

describe('5c. terms and refund policy links', () => {
  it('are <site origin>/terms and <site origin>/refund-policy, from the site config, not from the terms URL', async () => {
    const hosted = await billingWorld();
    expect(await json(await hosted.api(hosted.owner, 'GET', '/api/billing'))).toMatchObject({ terms_url: 'https://readysetmail.com/terms', refund_policy_url: 'https://readysetmail.com/refund-policy' });
    const custom = await billingWorld({ SITE_URL: 'https://www.example.org/' });
    expect(await json(await custom.api(custom.owner, 'GET', '/api/billing'))).toMatchObject({ terms_url: 'https://www.example.org/terms', refund_policy_url: 'https://www.example.org/refund-policy' });
    // a TERMS_URL on another page or host does not change where the two links point
    const odd = await billingWorld({ TERMS_URL: 'https://legal.example.net/en/agreement.html', SITE_URL: 'https://www.example.org' });
    const domainId = odd.addDomain(odd.owner.workspaceId, 'acme.com');
    for (const path of ['/api/billing', `/api/billing/domains/${domainId}`]) {
      expect(await json(await odd.api(odd.owner, 'GET', path)), path).toMatchObject({ terms_url: 'https://www.example.org/terms', refund_policy_url: 'https://www.example.org/refund-policy' });
    }
  });
});
