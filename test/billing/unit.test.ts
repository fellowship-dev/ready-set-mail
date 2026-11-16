// The pure pieces of billing: configuration, the Stripe client, the order state machine and the return-path allow-list.
import { describe, it, expect, vi } from 'vitest';
import { inspect } from 'node:util';
import { billingStatus, stripeApiBase, priceLookupKey, STRIPE_API_VERSION } from '../../src/billing/config';
import { StripeClient, StripeError, StripeNetworkError, encodeForm } from '../../src/billing/stripe-client';
import { ORDER_FLOW, canMove, predecessorsOf, orderView } from '../../src/billing/orders';
import { appUrl, safeReturnPath } from '../../src/billing/paths';
import { validatePrice, PriceMisconfiguredError } from '../../src/billing/price';
import { OFFER_SCOPE, REFUND_RULE, NEXT_STEPS } from '../../src/billing/offer';

const HOSTED = { MODE: 'saas', SAAS_ENABLED: '1' };

describe('billingStatus', () => {
  it('is off outside the hosted service, whatever is set', () => {
    expect(billingStatus({ STRIPE_SECRET_KEY: 'rk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toEqual({ state: 'off' });
    expect(billingStatus({ MODE: 'saas', STRIPE_SECRET_KEY: 'rk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toEqual({ state: 'off' }); // SAAS_ENABLED missing
  });
  it('is off when neither secret is set, configured with a restricted key and a webhook secret', () => {
    expect(billingStatus(HOSTED)).toEqual({ state: 'off' });
    expect(billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' })).toEqual({ state: 'configured', livemode: false });
    expect(billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: 'rk_live_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' })).toEqual({ state: 'configured', livemode: true });
  });
  it('refuses a full sk_ key, naming the setting and never the value', () => {
    for (const key of ['sk_live_SECRETVALUE123', 'sk_test_SECRETVALUE123']) {
      const s = billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_abc123' });
      expect(s.state).toBe('misconfigured');
      expect((s as { reason: string }).reason).toMatch(/restricted/);
      expect(JSON.stringify(s)).not.toContain('SECRETVALUE');
    }
  });
  it('is misconfigured when only one secret is set or a prefix is wrong', () => {
    expect(billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: 'rk_test_abc123' }).state).toBe('misconfigured');
    expect(billingStatus({ ...HOSTED, STRIPE_WEBHOOK_SECRET: 'whsec_abc123' }).state).toBe('misconfigured');
    expect(billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: 'pk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' }).state).toBe('misconfigured');
    expect(billingStatus({ ...HOSTED, STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'abc123' }).state).toBe('misconfigured');
  });
  it('the price lookup key defaults and ignores nonsense', () => {
    expect(priceLookupKey({})).toBe('rsm_fix_one_domain');
    expect(priceLookupKey({ STRIPE_PRICE_LOOKUP_KEY: 'custom_key' })).toBe('custom_key');
    expect(priceLookupKey({ STRIPE_PRICE_LOOKUP_KEY: 'bad key&x=1' })).toBe('rsm_fix_one_domain');
  });
});

describe('STRIPE_API_BASE (test only)', () => {
  it('is honoured only for http://127.0.0.1 or http://localhost with a port', () => {
    expect(stripeApiBase('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    expect(stripeApiBase('http://localhost:4010/')).toBe('http://localhost:4010');
  });
  it('anything else keeps the real API, so the key can never be sent elsewhere', () => {
    for (const v of ['https://evil.example', 'http://evil.example:80', 'http://127.0.0.1.evil.example:80', 'http://127.0.0.1:80@evil.example', 'http://user@127.0.0.1:80', 'http://127.0.0.1:80/path', 'https://127.0.0.1:4010', 'http://127.0.0.1', '', 'javascript:1']) {
      expect(stripeApiBase(v), v).toBe('https://api.stripe.com');
    }
    expect(stripeApiBase(undefined)).toBe('https://api.stripe.com');
  });
});

describe('StripeClient', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (status: number, body: unknown) => vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return Response.json(body, { status }); });

  it('pins the API version, sends the key as a bearer and an Idempotency-Key on POSTs, form encoded', async () => {
    calls.length = 0;
    const c = new StripeClient('rk_test_secretvalue', { fetch: respond(200, { id: 'cus_1' }) as unknown as typeof fetch });
    await c.createCustomer({ workspaceId: 'ws_1', email: 'a@b.co', name: 'Acme & Co' });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/customers');
    const h = init.headers as Record<string, string>;
    expect(h['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(h.Authorization).toBe('Bearer rk_test_secretvalue');
    expect(h['Idempotency-Key']).toBe('rsm-cust-ws_1');
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('email=a%40b.co&name=Acme%20%26%20Co&metadata%5Bworkspace_id%5D=ws_1');
  });

  it('keys every invoice step by the order id, and the card session by our ref', async () => {
    calls.length = 0;
    const c = new StripeClient('rk_test_x', { fetch: respond(200, { id: 'x' }) as unknown as typeof fetch });
    await c.createInvoice({ orderId: 'ord_1', workspaceId: 'ws_1', customerId: 'cus_1', currency: 'usd', domain: 'acme.com', offer: 'fix-one-domain', description: 'd' });
    await c.createInvoiceItem({ orderId: 'ord_1', customerId: 'cus_1', invoiceId: 'in_1', priceId: 'price_1', description: 'd' });
    await c.finalizeInvoice('ord_1', 'in_1');
    await c.payInvoice('ord_1', 'in_1');
    await c.voidInvoice('ord_1', 'in_1');
    await c.createSetupSession({ ref: 'bcs_1', customerId: 'cus_1', workspaceId: 'ws_1', purpose: 'add_card', successUrl: 'https://x/ok?s={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/no' });
    expect(calls.map((x) => (x.init.headers as Record<string, string>)['Idempotency-Key'])).toEqual(['rsm-ord_1-invoice', 'rsm-ord_1-item', 'rsm-ord_1-finalize', 'rsm-ord_1-pay', 'rsm-ord_1-void', 'rsm-cs-bcs_1']);
    const invoice = String(calls[0]!.init.body);
    for (const part of ['collection_method=charge_automatically', 'auto_advance=false', 'pending_invoice_items_behavior=exclude', 'metadata%5Border_id%5D=ord_1', 'metadata%5Bworkspace_id%5D=ws_1', 'metadata%5Bdomain%5D=acme.com', 'metadata%5Boffer%5D=fix-one-domain']) expect(invoice).toContain(part);
    expect(String(calls[3]!.init.body)).toBe('off_session=true');
    const session = String(calls[5]!.init.body);
    for (const part of ['mode=setup', 'payment_method_types%5B%5D=card', 'customer=cus_1', 'client_reference_id=ws_1', 'metadata%5Bpurpose%5D=add_card', 'success_url=https%3A%2F%2Fx%2Fok%3Fs%3D%7BCHECKOUT_SESSION_ID%7D']) expect(session).toContain(part);
  });

  it('GETs carry no body and no idempotency key; arrays and nesting encode as Stripe expects', async () => {
    calls.length = 0;
    const c = new StripeClient('rk_test_x', { fetch: respond(200, { data: [] }) as unknown as typeof fetch });
    await c.listPrices('rsm_fix_one_domain');
    await c.findInvoicePayment('pi_1');
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/prices?lookup_keys%5B%5D=rsm_fix_one_domain&active=true&limit=2');
    expect(calls[1]!.url).toContain('payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1');
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    expect(encodeForm({ a: [{ b: 1 }, { b: 2 }], c: [1, 2], d: null, e: undefined, f: { g: true } })).toBe('a%5B0%5D%5Bb%5D=1&a%5B1%5D%5Bb%5D=2&c%5B%5D=1&c%5B%5D=2&f%5Bg%5D=true');
  });

  it('uses the injected local base only for the test fake', async () => {
    calls.length = 0;
    await new StripeClient('rk_test_x', { fetch: respond(200, { id: 'x' }) as unknown as typeof fetch, apiBase: 'http://127.0.0.1:9' }).retrieveCharge('ch_1');
    await new StripeClient('rk_test_x', { fetch: respond(200, { id: 'x' }) as unknown as typeof fetch, apiBase: 'https://evil.example' }).retrieveCharge('ch_1');
    expect(calls.map((x) => x.url)).toEqual(['http://127.0.0.1:9/v1/charges/ch_1', 'https://api.stripe.com/v1/charges/ch_1']);
  });

  it('never shows the key in errors, JSON or inspect output', async () => {
    const key = 'rk_test_TOPSECRETKEYVALUE';
    const c = new StripeClient(key, { fetch: respond(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } }) as unknown as typeof fetch });
    const e = await c.payInvoice('ord_1', 'in_1').catch((x) => x);
    expect(e).toBeInstanceOf(StripeError);
    expect(e).toMatchObject({ status: 402, type: 'card_error', code: 'card_declined', declineCode: 'generic_decline', isCardError: true });
    for (const shown of [JSON.stringify(c), inspect(c), inspect(c, { showHidden: true, depth: 5 }), String(e.message), JSON.stringify(e), inspect(e), String(e.stack)]) expect(shown).not.toContain('TOPSECRET');
  });

  it('maps a network failure, a timeout and a non-JSON answer to StripeNetworkError', async () => {
    const down = new StripeClient('rk_test_x', { fetch: (async () => { throw new Error('boom rk_test_x'); }) as unknown as typeof fetch });
    const e1 = await down.retrieveCharge('ch_1').catch((x) => x);
    expect(e1).toBeInstanceOf(StripeNetworkError);
    expect(e1.message).not.toContain('rk_test');
    const html = new StripeClient('rk_test_x', { fetch: (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch });
    expect(await html.retrieveCharge('ch_1').catch((x) => x)).toBeInstanceOf(StripeNetworkError);
  });
});

describe('order state machine', () => {
  const all = Object.keys(ORDER_FLOW) as Array<keyof typeof ORDER_FLOW>;
  it('allows exactly the moves of the brief and nothing backwards', () => {
    expect(ORDER_FLOW).toEqual({
      pending: ['paid', 'failed', 'canceled'], paid: ['started', 'refunded'], started: ['done', 'refunded'], done: ['refunded'],
      refunded: [], failed: [], canceled: [],
    });
    for (const a of all) for (const b of all) if (canMove(a, b)) expect(ORDER_FLOW[b]).not.toContain(a); // no two-way moves
  });
  it('final states move nowhere; refunded is reachable from paid, started and done only', () => {
    for (const s of ['refunded', 'failed', 'canceled'] as const) expect(ORDER_FLOW[s]).toEqual([]);
    expect(predecessorsOf('refunded').sort()).toEqual(['done', 'paid', 'started']);
    expect(predecessorsOf('paid')).toEqual(['pending']);
    expect(predecessorsOf('done')).toEqual(['started']);
  });
  it('the view of an order exposes no Stripe ids, no buyer id and no internal notes', () => {
    const v = orderView({ id: 'ord_1', workspace_id: 'ws', workspace_name: 'W', domain_id: 1, domain_name: 'a.com', offer: 'fix-one-domain', stripe_price_id: 'price_x', amount: 14900, currency: 'usd', status: 'pending', stripe_customer_id: 'cus_x', stripe_invoice_id: 'in_x', stripe_payment_intent_id: 'pi_x', stripe_charge_id: 'ch_x', hosted_invoice_url: 'https://pay/x', amount_refunded: 0, buyer_user_id: 'u', buyer_email: 'b@x.co', failure_code: null, failure_message: null, note: 'action_required', owner_notified_at: null, created_at: 1, updated_at: 1, paid_at: null, started_at: null, done_at: null, refunded_at: null, failed_at: null });
    const text = JSON.stringify(v);
    for (const secret of ['cus_x', 'in_x', 'pi_x', 'ch_x', 'price_x', '"u"', 'ws']) expect(text).not.toContain(secret);
    expect(v).toMatchObject({ action_required: true, action_url: 'https://pay/x' });
  });
});

describe('return paths', () => {
  it('accepts only the app routes the flow uses', () => {
    for (const p of ['/settings', '/domains/7', '/domains/123456789', '/domains/7?order=fix-one-domain', '/', '/?zones=confirm', '/add', '/add?domain=example.com', '/settings?plan=start']) expect(safeReturnPath(p), p).toBe(p);
  });
  it('refuses every open-redirect and forgery shape', () => {
    const bad = ['//evil.example', '/\\evil.example', '\\\\evil.example', 'https://evil.example', 'http://evil.example/settings', 'javascript:alert(1)', '/%2F%2Fevil.example', '/settings%0d%0aLocation:evil', '/settings\n', '/settings\r', '/settings\t', '/settings\u0000', '/domains/0', '/domains/007', '/domains/1/settings', '/domains/x', '/domains/1234567890', '/settings?order=other', '/settings?next=https://evil.example', '/settings#x', '/api/billing', '', ' /settings', '/settings ', 'settings', '/settings/../x', '/' + 'a'.repeat(200), '/%73ettings', '/domains/7?order=fix-one-domain&x=1', '/domains/7//x', '/?zones=other', '/add?domain=-bad', '/add?domain=a.com&x=1', '//?zones=confirm', '/add?domain=%2e'];
    for (const p of bad) expect(safeReturnPath(p), JSON.stringify(p)).toBeNull();
    for (const v of [undefined, null, 5, {}, ['/settings'], true]) expect(safeReturnPath(v)).toBeNull();
  });
  it('builds the app URL from the stored workspace, keeping a query and adding ours', () => {
    expect(appUrl('https://app.example', 'ws_1', '/settings', { card: 'added' })).toBe('https://app.example/#/w/ws_1/settings?card=added');
    expect(appUrl('', 'ws_1', '/domains/7?order=fix-one-domain', { card: 'canceled' })).toBe('/#/w/ws_1/domains/7?order=fix-one-domain&card=canceled');
    expect(appUrl('', 'ws a/b', '/settings')).toBe('/#/w/ws%20a%2Fb/settings');
  });
});

describe('price validation', () => {
  const good = { id: 'price_1', active: true, type: 'one_time', currency: 'usd', unit_amount: 14900, billing_scheme: 'per_unit' };
  it('accepts one active one-time USD price with a fixed amount', () => {
    expect(validatePrice({ data: [good] }, 'k')).toEqual({ price_id: 'price_1', amount: 14900, currency: 'usd' });
  });
  it.each([
    ['none', { data: [] }], ['two', { data: [good, { ...good, id: 'price_2' }] }],
    ['inactive', { data: [{ ...good, active: false }] }], ['recurring', { data: [{ ...good, type: 'recurring', recurring: { interval: 'month' } }] }],
    ['eur', { data: [{ ...good, currency: 'eur' }] }], ['tiered', { data: [{ ...good, billing_scheme: 'tiered' }] }],
    ['zero', { data: [{ ...good, unit_amount: 0 }] }], ['null amount', { data: [{ ...good, unit_amount: null }] }], ['fractional', { data: [{ ...good, unit_amount: 1.5 }] }],
  ])('refuses a misconfigured price: %s', (_n, list) => {
    expect(() => validatePrice(list as { data: unknown[] }, 'k')).toThrow(PriceMisconfiguredError);
  });
});

describe('the words of the offer', () => {
  it('are the website\'s, verbatim, and promise no turnaround time', () => {
    expect(OFFER_SCOPE).toBe('The authentication part of Fix it, for one domain: every authorized sender confirmed, SPF and DKIM fixed, DMARC moved to reject.');
    expect(REFUND_RULE).toBe('Until we send the written note that the domain is done, you can ask for the full fee back.');
    expect(NEXT_STEPS).toBe('We will write to you about the access the work needs. The work starts when you have given it, and ends with our written note that the domain is done.');
    expect(`${OFFER_SCOPE} ${REFUND_RULE} ${NEXT_STEPS}`).not.toMatch(/\b(hours?|days?|weeks?|within|business|turnaround|\d+ ?h)\b/i);
  });
});
