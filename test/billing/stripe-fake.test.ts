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
    fake.completeInvoiceAction(open.id, 'succeed');
    expect(fake.state.invoices.get(open.id)!.status).toBe('paid');
    expect([...fake.state.paymentIntents.values()]).toHaveLength(1);
    const paidEv = [...fake.state.events.values()].find(e => e.type === 'invoice.paid')!;
    expect(paidEv.data.object).toMatchObject({ id: open.id, status: 'paid' });
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
