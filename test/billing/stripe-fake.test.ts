import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STRIPE_FAKE_API_VERSION, createFakeStripe, parseStripeForm, signStripePayload, startFakeStripe,
  type FakeStripe,
} from '../../e2e/support/fake-stripe.mjs';

const T0 = 1_800_000_000_000;
const KEY = 'rk_test_secret';

function mk(opts: Parameters<typeof createFakeStripe>[0] = {}) {
  return createFakeStripe({ now: () => T0, autoDeliver: false, ...opts });
}

type Params = Record<string, string>;
async function api(fake: FakeStripe, method: string, path: string, params: Params | string = {}, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_FAKE_API_VERSION, ...headers };
  const body = typeof params === 'string' ? params : new URLSearchParams(params).toString();
  const init: RequestInit = { method, headers: h };
  let url = `https://api.stripe.com${path}`;
  if (method === 'GET') { if (body) url += `?${body}`; } else { init.body = body; h['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const res = await fake.fetch(url, init);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, status: res.status, json: (await res.json()) as any };
}

async function customerWithCard(fake: FakeStripe, card?: 'ok' | 'decline' | 'requires_action') {
  const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json;
  const sess = (await api(fake, 'POST', '/v1/checkout/sessions', {
    mode: 'setup', customer: cust.id, success_url: 'https://app/ok?cs={CHECKOUT_SESSION_ID}', cancel_url: 'https://app/no', 'payment_method_types[]': 'card',
  })).json;
  fake.completeCheckout(sess.id, card ? { card } : {});
  const full = (await api(fake, 'GET', `/v1/checkout/sessions/${sess.id}`, 'expand[]=setup_intent')).json;
  const pm = full.setup_intent.payment_method;
  await api(fake, 'POST', `/v1/customers/${cust.id}`, { 'invoice_settings[default_payment_method]': pm });
  return { cust: cust.id as string, pm: pm as string, sess: sess.id as string };
}

async function openInvoice(fake: FakeStripe, cust: string) {
  const inv = (await api(fake, 'POST', '/v1/invoices', { customer: cust, collection_method: 'charge_automatically', auto_advance: 'false', currency: 'usd' })).json;
  const item = await api(fake, 'POST', '/v1/invoiceitems', { customer: cust, invoice: inv.id, price: 'price_fake_fix_one_domain' });
  expect(item.json.amount).toBe(14900);
  const fin = await api(fake, 'POST', `/v1/invoices/${inv.id}/finalize`);
  expect(fin.json.status).toBe('open');
  return fin.json;
}

describe('form parsing', () => {
  it('round trips bracket notation', () => {
    const q = 'a[b]=c&a[d][e]=f&x[]=1&x[]=2&l[0][k]=v&l[0][j]=w&l[1][k]=z&s=hello+world%21';
    expect(parseStripeForm(q)).toEqual({ a: { b: 'c', d: { e: 'f' } }, x: ['1', '2'], l: [{ k: 'v', j: 'w' }, { k: 'z' }], s: 'hello world!' });
  });
  it('is applied to bodies and queries and recorded in calls', async () => {
    const fake = mk();
    await api(fake, 'POST', '/v1/customers', 'email=a%40b.test&metadata[workspace_id]=w1');
    await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=rsm_fix_one_domain&active=true&limit=2');
    expect(fake.calls[0].form).toEqual({ email: 'a@b.test', metadata: { workspace_id: 'w1' } });
    expect(fake.calls[1].query).toEqual({ lookup_keys: ['rsm_fix_one_domain'], active: 'true', limit: '2' });
    expect(fake.state.customers.size).toBe(1);
  });
});

describe('auth and version', () => {
  it('rejects a wrong API version', async () => {
    const fake = mk();
    const r = await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' }, { 'Stripe-Version': '2020-08-27' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('api_version_invalid');
    expect(fake.state.customers.size).toBe(0);
  });
  it('requires a restricted or secret key, records only the prefix', async () => {
    const fake = mk();
    expect((await api(fake, 'GET', '/v1/prices', {}, { Authorization: 'Bearer pk_test_x' })).status).toBe(401);
    expect((await fake.fetch('https://x/v1/prices', { headers: { 'Stripe-Version': STRIPE_FAKE_API_VERSION } })).status).toBe(401);
    expect((await api(fake, 'GET', '/v1/prices', {}, { Authorization: 'Bearer sk_live_abc' })).status).toBe(200);
    await api(fake, 'GET', '/v1/prices');
    expect(fake.keySeen).toEqual(['sk_live_', 'rk_test_']);
    expect(JSON.stringify(fake.calls)).not.toContain('secret');
    expect(fake.calls.map(c => c.headers.hasAuth)).toEqual([true, false, true, true]);
  });
  it('rejects non-form POST bodies and unknown routes', async () => {
    const fake = mk();
    const r = await fake.fetch('https://x/v1/customers', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_FAKE_API_VERSION, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(400);
    const nf = await api(fake, 'GET', '/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe('resource_missing');
  });
});

describe('idempotency', () => {
  it('replays the same response and creates nothing new', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const p = { customer: cust, currency: 'usd' };
    const a = await api(fake, 'POST', '/v1/invoices', p, { 'Idempotency-Key': 'k1' });
    const b = await api(fake, 'POST', '/v1/invoices', p, { 'Idempotency-Key': 'k1' });
    expect(b.json).toEqual(a.json);
    expect(b.res.headers.get('Idempotent-Replayed')).toBe('true');
    expect(a.res.headers.get('Idempotent-Replayed')).toBeNull();
    expect(fake.state.invoices.size).toBe(1);
  });
  it('rejects the same key with different params', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    await api(fake, 'POST', '/v1/invoices', { customer: cust }, { 'Idempotency-Key': 'k1' });
    const r = await api(fake, 'POST', '/v1/invoices', { customer: cust, description: 'x' }, { 'Idempotency-Key': 'k1' });
    expect(r.status).toBe(400);
    expect(r.json.error.type).toBe('idempotency_error');
    expect(fake.state.invoices.size).toBe(1);
  });
});

describe('customers', () => {
  it('create, retrieve with expand, update default payment method, delete', async () => {
    const fake = mk();
    const { cust, pm } = await customerWithCard(fake);
    const plain = (await api(fake, 'GET', `/v1/customers/${cust}`)).json;
    expect(plain.invoice_settings.default_payment_method).toBe(pm);
    const exp = (await api(fake, 'GET', `/v1/customers/${cust}`, 'expand[]=invoice_settings.default_payment_method')).json;
    expect(exp.invoice_settings.default_payment_method).toMatchObject({ id: pm, object: 'payment_method', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: new Date(T0).getUTCFullYear() + 3 } });
    expect((await api(fake, 'POST', `/v1/customers/${cust}`, { 'invoice_settings[default_payment_method]': 'pm_nope' })).status).toBe(404);
    expect((await api(fake, 'GET', `/v1/payment_methods/${pm}`)).json.card.last4).toBe('4242');
    fake.deleteCustomer(cust);
    const r = await api(fake, 'GET', `/v1/customers/${cust}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: cust, object: 'customer', deleted: true });
  });
});

describe('checkout sessions', () => {
  it('validates, completes, substitutes the session id, and can cancel', async () => {
    const fake = mk({ publicBase: 'https://pay.test' });
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    expect((await api(fake, 'POST', '/v1/checkout/sessions', { mode: 'payment', customer: cust, success_url: 'https://a', cancel_url: 'https://b' })).status).toBe(400);
    expect((await api(fake, 'POST', '/v1/checkout/sessions', { mode: 'setup', customer: cust, cancel_url: 'https://b' })).json.error.param).toBe('success_url');
    const s = (await api(fake, 'POST', '/v1/checkout/sessions', { mode: 'setup', customer: cust, success_url: 'https://a/{CHECKOUT_SESSION_ID}', cancel_url: 'https://b', client_reference_id: 'ref', 'metadata[workspace_id]': 'w1' })).json;
    expect(s).toMatchObject({ status: 'open', url: `https://pay.test/pay/${s.id}`, client_reference_id: 'ref', metadata: { workspace_id: 'w1' }, mode: 'setup' });
    expect(s.id).toMatch(/^cs_test_/);
    expect(fake.completeCheckout(s.id, { card: 'cancel' })).toBe('https://b');
    expect((await api(fake, 'GET', `/v1/checkout/sessions/${s.id}`)).json.status).toBe('open');
    fake.setNextCard('decline');
    expect(fake.completeCheckout(s.id)).toBe(`https://a/${s.id}`);
    const done = (await api(fake, 'GET', `/v1/checkout/sessions/${s.id}`)).json;
    expect(done.status).toBe('complete');
    expect(typeof done.setup_intent).toBe('string');
    const exp = (await api(fake, 'GET', `/v1/checkout/sessions/${s.id}`, 'expand[]=setup_intent')).json;
    expect(exp.setup_intent).toMatchObject({ object: 'setup_intent', status: 'succeeded', customer: cust });
    expect(fake.state.paymentMethods.get(exp.setup_intent.payment_method)!.card.last4).toBe('0002');
    // completion does not set the default payment method
    expect(fake.state.customers.get(cust)!.invoice_settings.default_payment_method).toBeNull();
    expect([...fake.state.events.values()].map(e => e.type)).toEqual(['checkout.session.completed']);
  });
});

describe('prices', () => {
  it('looks up by lookup_keys and seedPrice overrides', async () => {
    const fake = mk();
    const r = (await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=rsm_fix_one_domain&active=true&limit=2')).json;
    expect(r.object).toBe('list');
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ id: 'price_fake_fix_one_domain', unit_amount: 14900, currency: 'usd', type: 'one_time', active: true, billing_scheme: 'per_unit' });
    fake.seedPrice({ lookup_key: 'rsm_fix_one_domain', unit_amount: 9900 });
    fake.seedPrice({ id: 'price_other', lookup_key: 'other', unit_amount: 100, active: false });
    expect((await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=rsm_fix_one_domain')).json.data[0].unit_amount).toBe(9900);
    expect((await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=other&active=true')).json.data).toHaveLength(0);
    expect((await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=nothing')).json.data).toEqual([]);
  });
});

describe('invoices', () => {
  it('happy path: paid, payments shape, no payment_intent/charge on invoice or invoice on charge', async () => {
    const fake = mk();
    const { cust, pm } = await customerWithCard(fake);
    const open = await openInvoice(fake, cust);
    expect(open).toMatchObject({ status: 'open', total: 14900, amount_due: 14900 });
    expect(open.hosted_invoice_url).toBe(`https://stripe.fake/i/${open.id}`);
    const paid = await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    expect(paid.status).toBe(200);
    expect(paid.json).toMatchObject({ status: 'paid', amount_paid: 14900 });
    expect(paid.json.status_transitions.paid_at).toBe(T0 / 1000);
    const got = (await api(fake, 'GET', `/v1/invoices/${open.id}`, 'expand[]=payments.data.payment.payment_intent')).json;
    expect(got).not.toHaveProperty('payment_intent');
    expect(got).not.toHaveProperty('charge');
    expect(got.payments.object).toBe('list');
    const ip = got.payments.data[0];
    expect(ip).toMatchObject({ object: 'invoice_payment', status: 'paid', amount_paid: 14900, payment: { type: 'payment_intent' } });
    expect(ip.id).toMatch(/^inpay_/);
    const pi = ip.payment.payment_intent;
    expect(pi).toMatchObject({ object: 'payment_intent', status: 'succeeded', payment_method: pm });
    expect(pi.latest_charge).toMatch(/^ch_/);
    const unexpanded = (await api(fake, 'GET', `/v1/invoices/${open.id}`, 'expand[]=payments')).json;
    expect(unexpanded.payments.data[0].payment.payment_intent).toBe(pi.id);
    expect(await api(fake, 'GET', `/v1/invoices/${open.id}`).then(r => r.json)).not.toHaveProperty('payments');
    const ch = (await api(fake, 'GET', `/v1/charges/${pi.latest_charge}`)).json;
    expect(ch).toMatchObject({ amount: 14900, amount_refunded: 0, refunded: false, customer: cust, payment_intent: pi.id, status: 'succeeded' });
    expect(ch).not.toHaveProperty('invoice');
    const lookup = (await api(fake, 'GET', '/v1/invoice_payments', `payment[type]=payment_intent&payment[payment_intent]=${pi.id}&limit=1`)).json;
    expect(lookup.data).toHaveLength(1);
    expect(lookup.data[0].invoice).toBe(open.id);
    const types = [...fake.state.events.values()].map(e => e.type);
    expect(types).toEqual(expect.arrayContaining(['invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded']));
  });

  it('decline: 402 card_declined, stays open, can be voided', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake, 'decline');
    const open = await openInvoice(fake, cust);
    const r = await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' });
    const got = (await api(fake, 'GET', `/v1/invoices/${open.id}`, 'expand[]=payments.data.payment.payment_intent')).json;
    expect(got.status).toBe('open');
    expect(got.payments.data[0].status).toBe('open');
    expect(got.payments.data[0].payment.payment_intent).toMatchObject({ status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } });
    expect([...fake.state.events.values()].some(e => e.type === 'invoice.payment_failed')).toBe(true);
    const v = await api(fake, 'POST', `/v1/invoices/${open.id}/void`);
    expect(v.json.status).toBe('void');
  });

  it('requires_action: 402, then completeInvoiceAction succeed pays and queues invoice.paid', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake, 'requires_action');
    const open = await openInvoice(fake, cust);
    const r = await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe('invoice_payment_intent_requires_action');
    expect(r.json.error.message).toBe('This payment requires additional user action before it can be completed successfully.');
    expect(fake.state.invoices.get(open.id)!.status).toBe('open');
    expect([...fake.state.paymentIntents.values()][0].status).toBe('requires_action');
    expect([...fake.state.events.values()].some(e => e.type === 'invoice.payment_action_required')).toBe(true);
    // as real Stripe does for a payment that needs the bank: invoice.payment_failed too, while the intent is still requires_action
    expect([...fake.state.events.values()].map(e => e.type).filter(t => t === 'invoice.payment_failed')).toHaveLength(1);
    fake.completeInvoiceAction(open.id, 'succeed');
    expect(fake.state.invoices.get(open.id)!.status).toBe('paid');
    expect([...fake.state.paymentIntents.values()]).toHaveLength(1);
    const paidEv = [...fake.state.events.values()].find(e => e.type === 'invoice.paid')!;
    expect(paidEv.data.object).toMatchObject({ id: open.id, status: 'paid' });
  });

  it('lists the lines (price, quantity, currency), applies a customer credit at finalize, and deletes an item only from a draft', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    fake.setCustomerBalance(cust, -900);
    const inv = (await api(fake, 'POST', '/v1/invoices', { customer: cust, auto_advance: 'false', currency: 'usd' })).json;
    const item = (await api(fake, 'POST', '/v1/invoiceitems', { customer: cust, invoice: inv.id, price: 'price_fake_fix_one_domain' })).json;
    const draft = (await api(fake, 'GET', `/v1/invoices/${inv.id}`)).json;
    expect(draft.lines.data).toHaveLength(1);
    expect(draft.lines.data[0]).toMatchObject({ quantity: 1, currency: 'usd', amount: 14900, pricing: { price_details: { price: 'price_fake_fix_one_domain' } }, parent: { invoice_item_details: { invoice_item: item.id } } });
    expect(draft).toMatchObject({ amount_due: 14900, status: 'draft' });
    const fin = (await api(fake, 'POST', `/v1/invoices/${inv.id}/finalize`)).json;
    expect(fin).toMatchObject({ total: 14900, amount_due: 14000, starting_balance: -900 });
    expect(fake.state.customers.get(cust)!.balance).toBe(0);
    expect((await api(fake, 'DELETE', `/v1/invoiceitems/${item.id}`)).json.error.code).toBe('invoice_not_editable');
    const paid = (await api(fake, 'POST', `/v1/invoices/${inv.id}/pay`, { off_session: 'true' })).json;
    expect(paid).toMatchObject({ status: 'paid', amount_paid: 14000 });
    const d2 = (await api(fake, 'POST', '/v1/invoices', { customer: cust, auto_advance: 'false', currency: 'usd' })).json;
    const i2 = (await api(fake, 'POST', '/v1/invoiceitems', { customer: cust, invoice: d2.id, price: 'price_fake_fix_one_domain' })).json;
    expect((await api(fake, 'DELETE', `/v1/invoiceitems/${i2.id}`)).json).toMatchObject({ deleted: true });
    expect((await api(fake, 'GET', `/v1/invoices/${d2.id}`)).json.lines.data).toHaveLength(0);
  });

  it('fail action queues invoice.payment_failed', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake, 'requires_action');
    const open = await openInvoice(fake, cust);
    await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    fake.completeInvoiceAction(open.id, 'fail');
    expect([...fake.state.events.values()].some(e => e.type === 'invoice.payment_failed')).toBe(true);
    expect(fake.state.invoices.get(open.id)!.status).toBe('open');
  });

  it('pay needs off_session, a default payment method, and an open invoice', async () => {
    const fake = mk();
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    const open = await openInvoice(fake, cust);
    expect((await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, {})).status).toBe(400);
    const r = await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invoice_no_payment_method');
  });

  it('rejects voiding a paid invoice', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const open = await openInvoice(fake, cust);
    await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    const r = await api(fake, 'POST', `/v1/invoices/${open.id}/void`);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invoice_not_open');
    expect(fake.state.invoices.get(open.id)!.status).toBe('paid');
  });

  it("rejects an invoice item pointing at another customer's invoice", async () => {
    const fake = mk();
    const a = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    const b = (await api(fake, 'POST', '/v1/customers', { email: 'b@b.test' })).json.id;
    const inv = (await api(fake, 'POST', '/v1/invoices', { customer: a })).json;
    const r = await api(fake, 'POST', '/v1/invoiceitems', { customer: b, invoice: inv.id, price: 'price_fake_fix_one_domain' });
    expect(r.status).toBe(400);
    expect(fake.state.invoiceItems.size).toBe(0);
  });
});

describe('refunds', () => {
  async function paidCharge(fake: FakeStripe) {
    const { cust } = await customerWithCard(fake);
    const open = await openInvoice(fake, cust);
    await api(fake, 'POST', `/v1/invoices/${open.id}/pay`, { off_session: 'true' });
    return [...fake.state.charges.keys()][0];
  }
  it('partial then full, with charge.refunded events', async () => {
    const fake = mk();
    const ch = await paidCharge(fake);
    fake.refund(ch, 5000);
    let c = (await api(fake, 'GET', `/v1/charges/${ch}`)).json;
    expect(c).toMatchObject({ amount_refunded: 5000, refunded: false });
    fake.refund(ch);
    c = (await api(fake, 'GET', `/v1/charges/${ch}`)).json;
    expect(c).toMatchObject({ amount_refunded: 14900, refunded: true });
    const evs = [...fake.state.events.values()].filter(e => e.type === 'charge.refunded');
    expect(evs.map(e => e.data.object.amount_refunded)).toEqual([5000, 14900]);
    expect(evs[1].data.object).toMatchObject({ id: ch, object: 'charge', refunded: true });
    expect(() => fake.refund(ch, 1)).toThrow();
  });
});

describe('webhooks', () => {
  it('signStripePayload matches a reference HMAC', async () => {
    const body = '{"a":1}';
    const hex = createHmac('sha256', 'whsec_x').update(`1700000000.${body}`).digest('hex');
    expect(await signStripePayload('whsec_x', body, 1700000000)).toBe(`t=1700000000,v1=${hex}`);
  });

  it('delivers signed raw JSON to an injected target; flush keeps creation order; redeliver replays', async () => {
    const fake = mk({ webhookSecret: 'whsec_test' });
    const seen: { sig: string | null; ct: string | null; body: string }[] = [];
    fake.setWebhookTarget(async req => { seen.push({ sig: req.headers.get('stripe-signature'), ct: req.headers.get('content-type'), body: await req.text() }); return new Response('ok'); });
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    const inv = (await api(fake, 'POST', '/v1/invoices', { customer: cust })).json;
    await api(fake, 'POST', '/v1/invoiceitems', { customer: cust, invoice: inv.id, price: 'price_fake_fix_one_domain' });
    await api(fake, 'POST', `/v1/invoices/${inv.id}/finalize`);
    expect(seen).toHaveLength(0);
    await fake.flush();
    expect(fake.deliveries.map(d => d.type)).toEqual(['invoice.created', 'invoice.finalized']);
    expect(fake.deliveries.every(d => d.status === 200)).toBe(true);
    const first = seen[0];
    expect(first.ct).toBe('application/json');
    const hex = createHmac('sha256', 'whsec_test').update(`${T0 / 1000}.${first.body}`).digest('hex');
    expect(first.sig).toBe(`t=${T0 / 1000},v1=${hex}`);
    expect(JSON.parse(first.body)).toMatchObject({ object: 'event', type: 'invoice.created', livemode: false, api_version: STRIPE_FAKE_API_VERSION });
    await fake.flush();
    expect(seen).toHaveLength(2);
    await fake.redeliver(fake.deliveries[0].eventId);
    expect(seen).toHaveLength(3);
    expect(seen[2].body).toBe(first.body);
  });

  it('autoDeliver sends after the response is returned', async () => {
    const fake = mk({ autoDeliver: true });
    let delivered = 0;
    fake.setWebhookTarget(async () => { delivered++; return new Response('ok'); });
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    await api(fake, 'POST', '/v1/invoices', { customer: cust });
    expect(delivered).toBe(0);
    await new Promise(r => setTimeout(r, 20));
    expect(delivered).toBe(1);
  });

  it('makeEvent builds without queueing; customer.deleted is queued by deleteCustomer', async () => {
    const fake = mk();
    const ev = fake.makeEvent('invoice.paid', { id: 'in_forged' });
    expect(ev).toMatchObject({ object: 'event', type: 'invoice.paid', created: T0 / 1000, data: { object: { id: 'in_forged' } } });
    expect(ev.id).toMatch(/^evt_/);
    expect(fake.state.events.size).toBe(0);
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    fake.deleteCustomer(cust);
    const [e] = [...fake.state.events.values()];
    expect(e.type).toBe('customer.deleted');
    expect(e.data.object).toMatchObject({ id: cust, deleted: true });
  });
});

describe('failNext, billing portal, reset', () => {
  it('injects one failure for a matching call', async () => {
    const fake = mk();
    fake.failNext('POST /v1/customers', { status: 503, error: { message: 'down' } });
    const a = await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' });
    expect(a.status).toBe(503);
    expect(a.json.error).toMatchObject({ type: 'api_error', message: 'down' });
    expect((await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).status).toBe(200);
    fake.failNext(/^GET \/v1\/prices/, { status: 429 });
    expect((await api(fake, 'GET', '/v1/prices')).status).toBe(429);
  });
  it('creates portal sessions and resets state', async () => {
    const fake = mk();
    const cust = (await api(fake, 'POST', '/v1/customers', { email: 'a@b.test' })).json.id;
    const p = (await api(fake, 'POST', '/v1/billing_portal/sessions', { customer: cust, return_url: 'https://app/billing' })).json;
    expect(p.url).toBe(`https://stripe.fake/portal/${p.id}`);
    fake.reset();
    expect(fake.state.customers.size).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(fake.state.prices.has('price_fake_fix_one_domain')).toBe(true);
  });
});

describe('subscriptions', () => {
  const MONTHLY = 'price_fake_extra_monthly';
  const types = (fake: FakeStripe) => [...fake.state.events.values()].map(e => e.type).filter(t => t !== 'checkout.session.completed');
  const create = (fake: FakeStripe, cust: string, params: Params = {}, headers: Record<string, string> = {}) =>
    api(fake, 'POST', '/v1/subscriptions', { customer: cust, 'items[0][price]': MONTHLY, 'items[0][quantity]': '0', 'metadata[workspace_id]': 'w1', ...params }, headers);
  const setQty = (fake: FakeStripe, item: string, quantity: number, extra: Params = {}) => api(fake, 'POST', `/v1/subscription_items/${item}`, { quantity: String(quantity), ...extra });
  const itemOf = (sub: { items: { data: { id: string }[] } }) => sub.items.data[0].id;

  it('seeds the recurring prices', async () => {
    const fake = mk();
    const r = (await api(fake, 'GET', '/v1/prices', 'lookup_keys[]=rsm_extra_domain_monthly&lookup_keys[]=rsm_extra_domain_yearly')).json;
    expect(r.data).toHaveLength(2);
    expect(r.data.find((p: { id: string }) => p.id === 'price_fake_extra_monthly')).toMatchObject({
      lookup_key: 'rsm_extra_domain_monthly', unit_amount: 500, currency: 'usd', type: 'recurring', billing_scheme: 'per_unit', product: 'prod_fake_extra',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    });
    expect(r.data.find((p: { id: string }) => p.id === 'price_fake_extra_yearly')).toMatchObject({ unit_amount: 5000, recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } });
  });

  it('quantity 0 is active with a paid $0 first invoice in the clover shape', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const r = await create(fake, cust);
    expect(r.status).toBe(200);
    const sub = r.json;
    expect(sub.id).toMatch(/^sub_fake/);
    expect(sub).toMatchObject({ object: 'subscription', status: 'active', customer: cust, metadata: { workspace_id: 'w1' }, cancel_at_period_end: false, canceled_at: null, collection_method: 'charge_automatically', created: T0 / 1000 });
    expect(sub).not.toHaveProperty('current_period_start');
    expect(sub).not.toHaveProperty('current_period_end');
    const item = sub.items.data[0];
    expect(item.id).toMatch(/^si_fake/);
    expect(item).toMatchObject({ quantity: 0, price: { id: MONTHLY, unit_amount: 500, recurring: { interval: 'month' } }, current_period_start: T0 / 1000 });
    expect(item.current_period_end).toBeGreaterThan(T0 / 1000 + 27 * 86400);
    const inv = (await api(fake, 'GET', `/v1/invoices/${sub.latest_invoice}`)).json;
    expect(inv).toMatchObject({ status: 'paid', total: 0, amount_due: 0, amount_paid: 0, billing_reason: 'subscription_create' });
    expect(inv).not.toHaveProperty('subscription');
    expect(inv.parent).toEqual({ type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: { workspace_id: 'w1' } } });
    expect(inv.lines.data[0]).toMatchObject({
      amount: 0, quantity: 0,
      parent: { type: 'subscription_item_details', subscription_item_details: { subscription: sub.id, subscription_item: item.id, proration: false, proration_details: { credited_items: null } } },
    });
    expect(fake.state.paymentIntents.size).toBe(0);
    expect(types(fake)).toEqual(['customer.subscription.created', 'invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded']);
    expect(fake.state.subscriptions.size).toBe(1);
    expect(fake.state.subscriptionItems.size).toBe(1);
  });

  it('quantity > 0 bills and pays the first invoice with the default card', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '3', 'items[0][price]': 'price_fake_extra_yearly' })).json;
    expect(sub.status).toBe('active');
    const inv = (await api(fake, 'GET', `/v1/invoices/${sub.latest_invoice}`)).json;
    expect(inv).toMatchObject({ status: 'paid', total: 15000, amount_paid: 15000, billing_reason: 'subscription_create' });
    expect(inv.lines.data[0].description).toBe('3 × Extra domain (at $50.00 / year)');
    expect(fake.state.charges.size).toBe(1);
    expect(types(fake)).toEqual(['customer.subscription.created', 'invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded']);
    const exp = (await api(fake, 'GET', `/v1/subscriptions/${sub.id}`, 'expand[]=latest_invoice')).json;
    expect(exp.latest_invoice).toMatchObject({ id: inv.id, object: 'invoice' });
  });

  it('first payment problems follow payment_behavior and the card', async () => {
    const fake = mk();
    const declined = await customerWithCard(fake, 'decline');
    const e = await create(fake, declined.cust, { 'items[0][quantity]': '1', payment_behavior: 'error_if_incomplete' });
    expect(e.status).toBe(402);
    expect(e.json.error).toMatchObject({ type: 'card_error', code: 'card_declined' });
    expect(fake.state.subscriptions.size).toBe(0);
    expect(fake.state.invoices.size).toBe(0);
    const inc = (await create(fake, declined.cust, { 'items[0][quantity]': '1', payment_behavior: 'default_incomplete' })).json;
    expect(inc.status).toBe('incomplete');
    expect(fake.state.invoices.get(inc.latest_invoice)!.status).toBe('open');
    expect(types(fake)).not.toContain('invoice.payment_failed');
    const allow = (await create(fake, declined.cust, { 'items[0][quantity]': '1' })).json;
    expect(allow.status).toBe('incomplete');
    expect(types(fake)).toContain('invoice.payment_failed');
    // a $0 subscription needs no card at all
    expect((await create(fake, declined.cust, { payment_behavior: 'error_if_incomplete' })).json.status).toBe('active');

    const three = await customerWithCard(fake, 'requires_action');
    const r = await create(fake, three.cust, { 'items[0][quantity]': '1', payment_behavior: 'error_if_incomplete' });
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe('invoice_payment_intent_requires_action');
    const pending = (await create(fake, three.cust, { 'items[0][quantity]': '1' })).json;
    expect(pending.status).toBe('incomplete');
    expect(types(fake)).toContain('invoice.payment_action_required');
    // authenticating the first invoice activates the subscription
    fake.completeInvoiceAction(pending.latest_invoice, 'succeed');
    expect(fake.state.subscriptions.get(pending.id)!.status).toBe('active');
    const ev = [...fake.state.events.values()].filter(x => x.type === 'customer.subscription.updated').pop()!;
    expect(ev.data.object).toMatchObject({ id: pending.id, status: 'active' });
    expect(ev.data.previous_attributes).toEqual({ status: 'incomplete' });
  });

  it('validates the create call and is idempotent', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    expect((await api(fake, 'POST', '/v1/subscriptions', { customer: cust })).status).toBe(400);
    expect((await create(fake, cust, { 'items[0][price]': 'price_fake_fix_one_domain' })).status).toBe(400);
    expect((await create(fake, cust, { 'items[0][price]': 'price_nope' })).status).toBe(404);
    expect((await create(fake, 'cus_nope')).status).toBe(404);
    const a = await create(fake, cust, {}, { 'Idempotency-Key': 'k1' });
    const b = await create(fake, cust, {}, { 'Idempotency-Key': 'k1' });
    expect(b.json).toEqual(a.json);
    expect(b.res.headers.get('Idempotent-Replayed')).toBe('true');
    expect(fake.state.subscriptions.size).toBe(1);
    const c = await create(fake, cust, { 'items[0][quantity]': '2' }, { 'Idempotency-Key': 'k1' });
    expect(c.status).toBe(400);
    expect(c.json.error.type).toBe('idempotency_error');
    expect(fake.state.subscriptions.size).toBe(1);
  });

  it('retrieves, lists with filters, updates metadata and cancel_at_period_end', async () => {
    const fake = mk();
    const a = await customerWithCard(fake);
    const b = await customerWithCard(fake);
    const s1 = (await create(fake, a.cust)).json;
    const s2 = (await create(fake, b.cust)).json;
    expect((await api(fake, 'GET', `/v1/subscriptions/${s1.id}`)).json.id).toBe(s1.id);
    expect((await api(fake, 'GET', '/v1/subscriptions/sub_nope')).status).toBe(404);
    const byCust = (await api(fake, 'GET', '/v1/subscriptions', `customer=${a.cust}&status=active&limit=5`)).json;
    expect(byCust).toMatchObject({ object: 'list', has_more: false });
    expect(byCust.data.map((x: { id: string }) => x.id)).toEqual([s1.id]);
    expect((await api(fake, 'GET', '/v1/subscriptions', 'status=all')).json.data).toHaveLength(2);
    expect((await api(fake, 'GET', '/v1/subscriptions', 'status=past_due')).json.data).toHaveLength(0);
    expect((await api(fake, 'GET', '/v1/subscriptions', 'limit=1')).json).toMatchObject({ has_more: true });

    const u = (await api(fake, 'POST', `/v1/subscriptions/${s2.id}`, { cancel_at_period_end: 'true', 'metadata[reason]': 'bye' })).json;
    expect(u).toMatchObject({ cancel_at_period_end: true, cancel_at: u.items.data[0].current_period_end, metadata: { workspace_id: 'w1', reason: 'bye' } });
    expect(u.canceled_at).toBe(T0 / 1000);
    const ev = [...fake.state.events.values()].filter(x => x.type === 'customer.subscription.updated').pop()!;
    expect(ev.data.previous_attributes).toMatchObject({ cancel_at_period_end: false, metadata: { workspace_id: 'w1' } });
    const back = (await api(fake, 'POST', `/v1/subscriptions/${s2.id}`, { cancel_at_period_end: 'false' })).json;
    expect(back).toMatchObject({ cancel_at_period_end: false, cancel_at: null, canceled_at: null });
  });

  it('DELETE cancels immediately without a refund', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    const del = await api(fake, 'DELETE', `/v1/subscriptions/${sub.id}`);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ id: sub.id, status: 'canceled', canceled_at: T0 / 1000, ended_at: T0 / 1000 });
    expect(types(fake)).toContain('customer.subscription.deleted');
    expect(fake.state.refunds.size).toBe(0);
    expect([...fake.state.charges.values()][0].amount_refunded).toBe(0);
    expect((await api(fake, 'GET', '/v1/subscriptions', `customer=${cust}`)).json.data).toHaveLength(0);
    expect((await api(fake, 'GET', '/v1/subscriptions', `customer=${cust}&status=canceled`)).json.data).toHaveLength(1);
    const missing = await api(fake, 'DELETE', '/v1/subscriptions/sub_nope');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('resource_missing');
    expect((await api(fake, 'DELETE', `/v1/subscriptions/${sub.id}`)).status).toBe(400);
  });

  it('quantity 0 -> 1 -> 2 -> 1 all succeed without a payment and record proration lines for the next invoice', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust)).json;
    const item = itemOf(sub);
    const start = sub.items.data[0].current_period_start; const end = sub.items.data[0].current_period_end;
    const charges = fake.state.charges.size;
    // halfway through the period
    fake.setNow(((start + end) / 2) * 1000);
    const up = await setQty(fake, item, 1);
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ id: item, quantity: 1 });
    expect((await setQty(fake, item, 2)).status).toBe(200);
    expect((await setQty(fake, item, 1)).status).toBe(200);
    expect(fake.state.charges.size).toBe(charges);
    expect(fake.state.invoices.size).toBe(1);
    expect(fake.state.subscriptions.get(sub.id)!.status).toBe('active');
    const evs = [...fake.state.events.values()].filter(x => x.type === 'customer.subscription.updated');
    expect(evs).toHaveLength(3);
    expect(evs[0].data.previous_attributes!.items.data[0].quantity).toBe(0);
    expect(evs[0].data.object.items.data[0].quantity).toBe(1);

    const half = (n: number) => Math.round(500 * n * ((end - (start + end) / 2) / (end - start)));
    const date = new Date(((start + end) / 2) * 1000);
    const dt = `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    const pv = (await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust, subscription: sub.id })).json;
    const lines = pv.lines.data as { amount: number; description: string; quantity: number; parent: { subscription_item_details: { proration: boolean } } }[];
    const prorations = lines.filter(l => l.parent.subscription_item_details.proration);
    expect(prorations.map(l => [l.description, l.amount])).toEqual([
      [`Remaining time on 1 × Extra domain after ${dt}`, half(1)],
      [`Unused time on 1 × Extra domain after ${dt}`, -half(1)],
      [`Remaining time on 2 × Extra domain after ${dt}`, half(2)],
      [`Unused time on 2 × Extra domain after ${dt}`, -half(2)],
      [`Remaining time on 1 × Extra domain after ${dt}`, half(1)],
    ]);
    const recurring = lines.filter(l => !l.parent.subscription_item_details.proration);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({ amount: 500, quantity: 1 });
    expect(pv.total).toBe(500 + half(1));

    // the renewal bills the recurring line at the current quantity and the pending prorations, once
    const { invoice } = fake.advancePeriod(sub.id);
    expect(invoice).toMatchObject({ billing_reason: 'subscription_cycle', status: 'paid', total: 500 + half(1), amount_paid: 500 + half(1) });
    expect(invoice!.lines.data).toHaveLength(6);
    const next = (await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust, subscription: sub.id })).json;
    expect(next.lines.data).toHaveLength(1);
    expect(next.total).toBe(500);
  });

  it('proration_behavior none records nothing; invalid values and canceled subscriptions are refused', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust)).json;
    const item = itemOf(sub);
    fake.setNow(T0 + 10 * 86400_000);
    expect((await setQty(fake, item, 2, { proration_behavior: 'none' })).status).toBe(200);
    const pv = (await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust, subscription: sub.id })).json;
    expect(pv.lines.data).toHaveLength(1);
    expect(pv.lines.data[0]).toMatchObject({ quantity: 2, amount: 1000 });
    expect((await setQty(fake, item, 3, { proration_behavior: 'always_invoice' })).status).toBe(400);
    expect((await setQty(fake, item, -1)).status).toBe(400);
    expect((await setQty(fake, 'si_nope', 1)).status).toBe(404);
    await api(fake, 'DELETE', `/v1/subscriptions/${sub.id}`);
    expect((await setQty(fake, item, 1)).status).toBe(400);
  });

  it('quantity updates are idempotent and reject the same key with other params', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust)).json;
    const item = itemOf(sub);
    const post = (quantity: string) => api(fake, 'POST', `/v1/subscription_items/${item}`, { quantity }, { 'Idempotency-Key': 'q1' });
    const a = await post('1');
    const b = await post('1');
    expect(b.json).toEqual(a.json);
    expect(b.res.headers.get('Idempotent-Replayed')).toBe('true');
    expect([...fake.state.events.values()].filter(x => x.type === 'customer.subscription.updated')).toHaveLength(1);
    const c = await post('2');
    expect(c.status).toBe(400);
    expect(c.json.error.type).toBe('idempotency_error');
    expect(fake.state.subscriptionItems.get(item)!.quantity).toBe(1);
  });

  it('create_preview: a change to an existing subscription, by item id or by price, changes nothing', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    const item = sub.items.data[0];
    const before = JSON.stringify([...fake.state.subscriptions.values(), ...fake.state.subscriptionItems.values(), ...fake.state.invoices.values()]);
    const events = fake.state.events.size;
    fake.setNow((item.current_period_start + (item.current_period_end - item.current_period_start) / 2) * 1000);
    const pv = (await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust, subscription: sub.id, 'subscription_details[items][0][id]': item.id, 'subscription_details[items][0][quantity]': '3' })).json;
    expect(pv).toMatchObject({
      id: null, object: 'invoice', status: 'draft', currency: 'usd', customer: cust, billing_reason: 'upcoming',
      period_end: item.current_period_end, next_payment_attempt: item.current_period_end,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
    });
    expect(pv).not.toHaveProperty('subscription');
    const half = Math.round((item.current_period_end - (item.current_period_start + item.current_period_end) / 2) / (item.current_period_end - item.current_period_start) * 500);
    const amounts = pv.lines.data.map((l: { amount: number }) => l.amount);
    expect(amounts).toEqual([-half, half * 3, 1500]);
    expect(pv.total).toBe(1500 + half * 2);
    expect(pv.amount_due).toBe(pv.total);
    const byPrice = (await api(fake, 'POST', '/v1/invoices/create_preview', { subscription: sub.id, 'subscription_details[items][0][price]': MONTHLY, 'subscription_details[items][0][quantity]': '3', 'subscription_details[proration_behavior]': 'none' })).json;
    expect(byPrice.total).toBe(1500);
    const withDate = (await api(fake, 'POST', '/v1/invoices/create_preview', { subscription: sub.id, 'subscription_details[items][0][id]': item.id, 'subscription_details[items][0][quantity]': '2', 'subscription_details[proration_date]': String(item.current_period_start) })).json;
    expect(withDate.lines.data.map((l: { amount: number }) => l.amount)).toEqual([-500, 1000, 1000]);
    expect(JSON.stringify([...fake.state.subscriptions.values(), ...fake.state.subscriptionItems.values(), ...fake.state.invoices.values()])).toBe(before);
    expect(fake.state.events.size).toBe(events);
    expect((await api(fake, 'POST', '/v1/invoices/create_preview', { subscription: 'sub_nope' })).status).toBe(404);
  });

  it('create_preview without a subscription previews a new one: amount due now is quantity x price', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const pv = (await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust, 'subscription_details[items][0][price]': 'price_fake_extra_yearly', 'subscription_details[items][0][quantity]': '4' })).json;
    expect(pv).toMatchObject({ id: null, status: 'draft', total: 20000, amount_due: 20000, currency: 'usd', billing_reason: 'subscription_create' });
    expect(pv.lines.data).toHaveLength(1);
    expect(pv.period_end).toBeGreaterThan(T0 / 1000 + 360 * 86400);
    expect(fake.state.subscriptions.size).toBe(0);
    expect(fake.state.invoices.size).toBe(0);
    expect((await api(fake, 'POST', '/v1/invoices/create_preview', { customer: cust })).status).toBe(400);
  });

  it('renewal with a working card: new period, paid invoice, events', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '2' })).json;
    const first = sub.items.data[0];
    const queued = fake.state.events.size;
    const r = fake.advancePeriod(sub.id);
    expect(r.invoice).toMatchObject({ billing_reason: 'subscription_cycle', status: 'paid', total: 1000 });
    expect(r.invoice!.parent.subscription_details.subscription).toBe(sub.id);
    expect(r.invoice).not.toHaveProperty('subscription');
    expect(r.invoice!.lines.data[0].period.start).toBe(first.current_period_end);
    expect(r.subscription.items.data[0].current_period_start).toBe(first.current_period_end);
    expect(r.subscription.items.data[0].current_period_end).toBeGreaterThan(first.current_period_end + 27 * 86400);
    expect(r.subscription.status).toBe('active');
    expect(r.subscription.latest_invoice).toBe(r.invoice!.id);
    expect([...fake.state.events.values()].slice(queued).map(e => e.type)).toEqual(['invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded', 'customer.subscription.updated']);
  });

  it('renewal with a declining card: open invoice, past_due, then a retry succeeds', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    fake.setCardBehavior(cust, 'decline');
    const queued = fake.state.events.size;
    const r = fake.advancePeriod(sub.id);
    expect(r.invoice).toMatchObject({ status: 'open', amount_due: 500, attempt_count: 1 });
    expect(r.subscription.status).toBe('past_due');
    const evs = [...fake.state.events.values()].slice(queued);
    expect(evs.map(e => e.type)).toEqual(['invoice.created', 'invoice.finalized', 'invoice.payment_failed', 'customer.subscription.updated']);
    expect(evs[3].data.previous_attributes).toMatchObject({ status: 'active' });
    expect(() => fake.advancePeriod(sub.id)).toThrow(/past_due/);
    // dunning: fails again, then the card works
    const again = fake.retryPayment(sub.id);
    expect(again.invoice).toMatchObject({ status: 'open', attempt_count: 2 });
    expect(again.subscription.status).toBe('past_due');
    const fixed = fake.retryPayment(sub.id, { card: 'ok' });
    expect(fixed.invoice).toMatchObject({ status: 'paid', amount_paid: 500 });
    expect(fixed.subscription.status).toBe('active');
    const last = [...fake.state.events.values()].filter(e => e.type === 'customer.subscription.updated').pop()!;
    expect(last.data.object.status).toBe('active');
    expect(last.data.previous_attributes).toEqual({ status: 'past_due' });
    expect(() => fake.retryPayment(sub.id)).toThrow(/no open invoice/);
  });

  it('renewal needing 3-D Secure: action events, past_due, hosted url; completing it activates the subscription', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    const queued = fake.state.events.size;
    const r = fake.advancePeriod(sub.id, { card: 'requires_action' });
    expect(r.subscription.status).toBe('past_due');
    expect(r.invoice).toMatchObject({ status: 'open', hosted_invoice_url: `https://stripe.fake/i/${r.invoice!.id}` });
    const t = [...fake.state.events.values()].slice(queued).map(e => e.type);
    expect(t).toEqual(['invoice.created', 'invoice.finalized', 'invoice.payment_action_required', 'invoice.payment_failed', 'customer.subscription.updated']);
    expect([...fake.state.paymentIntents.values()].pop()!.status).toBe('requires_action');
    fake.completeInvoiceAction(r.invoice!.id, 'succeed');
    expect(fake.state.invoices.get(r.invoice!.id)!.status).toBe('paid');
    expect(fake.state.subscriptions.get(sub.id)!.status).toBe('active');
    expect(types(fake).slice(-3)).toEqual(['invoice.paid', 'invoice.payment_succeeded', 'customer.subscription.updated']);
  });

  it('a failed authentication leaves the subscription past_due', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    const r = fake.advancePeriod(sub.id, { card: 'requires_action' });
    fake.completeInvoiceAction(r.invoice!.id, 'fail');
    expect(fake.state.subscriptions.get(sub.id)!.status).toBe('past_due');
    expect(fake.state.invoices.get(r.invoice!.id)!.status).toBe('open');
  });

  it('exhaustRetries ends dunning as unpaid or canceled', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const a = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    const b = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    expect(() => fake.exhaustRetries(a.id)).toThrow(/not past_due/);
    fake.setCardBehavior(cust, 'decline');
    fake.advancePeriod(a.id);
    fake.advancePeriod(b.id);
    const un = fake.exhaustRetries(a.id, { to: 'unpaid' });
    expect(un.subscription.status).toBe('unpaid');
    const ev = [...fake.state.events.values()].pop()!;
    expect(ev).toMatchObject({ type: 'customer.subscription.updated' });
    expect(ev.data.previous_attributes).toEqual({ status: 'past_due' });
    const gone = fake.exhaustRetries(b.id, { to: 'canceled' });
    expect(gone.subscription).toMatchObject({ status: 'canceled', canceled_at: T0 / 1000 });
    expect([...fake.state.events.values()].pop()!.type).toBe('customer.subscription.deleted');
    expect(gone.invoice!.status).toBe('open');
    // paying the old invoice later brings an unpaid subscription back
    fake.setCardBehavior(cust, 'ok');
    fake.retryPayment(a.id);
    expect(fake.state.subscriptions.get(a.id)!.status).toBe('active');
  });

  it('cancel_at_period_end ends the subscription at the next period boundary without an invoice', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const sub = (await create(fake, cust, { 'items[0][quantity]': '1' })).json;
    await api(fake, 'POST', `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: 'true' });
    const invoices = fake.state.invoices.size;
    const r = fake.advancePeriod(sub.id);
    expect(r.subscription).toMatchObject({ status: 'canceled', ended_at: sub.items.data[0].current_period_end });
    expect(fake.state.invoices.size).toBe(invoices);
    expect([...fake.state.events.values()].pop()!.type).toBe('customer.subscription.deleted');
  });

  it('setNow moves the clock, setCardBehavior needs a default card, reset clears subscriptions', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    fake.setNow(T0 + 5000_000);
    const sub = (await create(fake, cust)).json;
    expect(sub.created).toBe(T0 / 1000 + 5000);
    const bare = (await api(fake, 'POST', '/v1/customers', { email: 'x@y.test' })).json.id;
    expect(() => fake.setCardBehavior(bare, 'decline')).toThrow(/no default payment method/);
    expect(() => fake.setCardBehavior(cust, 'nope' as never)).toThrow(/unknown card kind/);
    // no card and a charge due: incomplete, never an exception
    expect((await create(fake, bare, { 'items[0][quantity]': '1' })).json.status).toBe('incomplete');
    fake.reset();
    expect(fake.state.subscriptions.size).toBe(0);
    expect(fake.state.subscriptionItems.size).toBe(0);
    expect(fake.state.prices.has('price_fake_extra_monthly')).toBe(true);
    const cust2 = (await api(fake, 'POST', '/v1/customers', { email: 'x@y.test' })).json.id;
    expect((await create(fake, cust2)).json.created).toBe(T0 / 1000);
  });

  it('the billing portal session offers nothing to change a quantity with', async () => {
    const fake = mk();
    const { cust } = await customerWithCard(fake);
    const p = (await api(fake, 'POST', '/v1/billing_portal/sessions', { customer: cust, return_url: 'https://app/billing' })).json;
    expect(Object.keys(p).sort()).toEqual(['created', 'customer', 'id', 'livemode', 'object', 'return_url', 'url']);
  });
});

describe('standalone server', () => {
  it('serves checkout pages, redirects to the success url, and exposes control endpoints', async () => {
    const hooks: string[] = [];
    const sink = await (async () => {
      const http = await import('node:http');
      const srv = http.createServer((req, res) => { hooks.push(`${req.method} ${req.headers['stripe-signature'] ? 'signed' : 'unsigned'}`); req.resume(); res.end('ok'); });
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
      return { srv, port: (srv.address() as { port: number }).port };
    })();
    const s = await startFakeStripe({ port: 0, now: () => T0, webhookUrl: `http://127.0.0.1:${sink.port}/hook` });
    try {
      const headers = { Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_FAKE_API_VERSION, 'Content-Type': 'application/x-www-form-urlencoded' };
      const post = async (path: string, params: Params) => (await fetch(`${s.url}${path}`, { method: 'POST', headers, body: new URLSearchParams(params) })).json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const cust = await post('/v1/customers', { email: 'a@b.test' });
      const sess = await post('/v1/checkout/sessions', { mode: 'setup', customer: cust.id, success_url: 'http://app.test/done?cs={CHECKOUT_SESSION_ID}', cancel_url: 'http://app.test/cancel' });
      expect(sess.url).toBe(`${s.url}/pay/${sess.id}`);
      const page = await fetch(sess.url);
      const text = await page.text();
      expect(text).toContain('Fake Stripe Checkout');
      expect(text).toContain('Use test card 4242');
      expect(text).toContain(`/pay/${sess.id}/complete?card=ok`);
      const r = await fetch(`${s.url}/pay/${sess.id}/complete?card=ok`, { redirect: 'manual' });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe(`http://app.test/done?cs=${sess.id}`);
      expect(s.fake.state.sessions.get(sess.id)!.status).toBe('complete');
      const state = await (await fetch(`${s.url}/__state`)).json() as { counts: Record<string, number>; calls: unknown[] };
      expect(state.counts.sessions).toBe(1);
      expect(JSON.stringify(state)).not.toContain(KEY);
      await new Promise(r2 => setTimeout(r2, 50));
      expect(hooks).toEqual(['POST signed']);
      expect((await fetch(`${s.url}/__reset`, { method: 'POST' })).status).toBe(200);
      expect(s.fake.state.sessions.size).toBe(0);
    } finally {
      await s.close();
      sink.srv.closeAllConnections();
      sink.srv.close();
    }
  });
});
