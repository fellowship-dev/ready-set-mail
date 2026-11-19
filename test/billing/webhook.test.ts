// POST /api/stripe/webhook: signature, tolerance, idempotency by event id, out-of-order events, forged events, and what is (not) logged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { billingWorld, call, json, rows, BASE, KEY, WHSEC, signStripePayload, ctx, type World } from './world';
import { handleApi } from '../../src/api/router';
import { parseSignatureHeader, verifySignature, WEBHOOK_MAX_BYTES } from '../../src/billing/webhook';
import { CARD_LAST4 } from '../helpers/card-text';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const hmacHex = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const now = () => Math.floor(Date.now() / 1000);
const eventCount = (w: World) => rows(w.db, 'SELECT COUNT(*) n FROM billing_events')[0].n as number;

async function withOrder(kind: 'ok' | 'requires_action' = 'ok') {
  const w = await billingWorld();
  const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
  await w.addCard(w.owner, kind);
  w.fake.setWebhookTarget(null);
  const bought = await json(await w.buy(w.owner, domainId));
  const invoice = [...w.fake.state.invoices.values()][0];
  return { w, orderId: bought.order.id as string, invoice, domainId };
}

describe('signature', () => {
  it('parses t and every v1, ignoring junk', () => {
    expect(parseSignatureHeader(`t=123,v1=${'a'.repeat(64)},v1=${'B'.repeat(64)},v0=zz,junk`)).toEqual({ t: 123, v1: ['a'.repeat(64), 'b'.repeat(64)] });
    for (const bad of [null, '', 't=1', `v1=${'a'.repeat(64)}`, `t=x,v1=${'a'.repeat(64)}`, 't=1,v1=short', 'a'.repeat(2000)]) expect(parseSignatureHeader(bad as string | null), String(bad).slice(0, 20)).toBeNull();
  });
  it('verifies HMAC-SHA256 over "t.body" with the secret, within 300 seconds either way', async () => {
    const body = new TextEncoder().encode('{"id":"evt_1"}');
    const t = 1_800_000_000;
    const good = `t=${t},v1=${await hmacHex(WHSEC, `${t}.{"id":"evt_1"}`)}`;
    expect(await verifySignature(WHSEC, body, good, t)).toBe(true);
    expect(await verifySignature(WHSEC, body, good, t + 300)).toBe(true);
    expect(await verifySignature(WHSEC, body, good, t + 301)).toBe(false);
    expect(await verifySignature(WHSEC, body, good, t - 301)).toBe(false);
    expect(await verifySignature('whsec_other', body, good, t)).toBe(false);
    expect(await verifySignature(WHSEC, new TextEncoder().encode('{"id":"evt_2"}'), good, t)).toBe(false);
    expect(await verifySignature(WHSEC, body, `t=${t + 1},v1=${await hmacHex(WHSEC, `${t}.{"id":"evt_1"}`)}`, t)).toBe(false); // t is part of what is signed
    const wrong = 'f'.repeat(64);
    expect(await verifySignature(WHSEC, body, `t=${t},v1=${wrong},v1=${await hmacHex(WHSEC, `${t}.{"id":"evt_1"}`)}`, t)).toBe(true); // any v1 may match
    expect(await verifySignature(WHSEC, body, `t=${t},v1=${wrong}`, t)).toBe(false);
  });
});

describe('the route', () => {
  it('rejects a missing, malformed, wrong-secret, tampered or stale signature with 400 and records nothing', async () => {
    const { w, orderId } = await withOrder();
    const ev = w.fake.makeEvent('invoice.paid', [...w.fake.state.invoices.values()][0]);
    const body = JSON.stringify(ev);
    const post = (headers: Record<string, string>, b = body) => handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body: b }), w.env as never, ctx);
    const t = now();
    await w.fake.flush();
    const seen = eventCount(w);
    const sig = (secret: string, tt: number, b = body) => hmacHex(secret, `${tt}.${b}`).then((h) => `t=${tt},v1=${h}`);
    const cases: Array<[string, Record<string, string>, string?]> = [
      ['no header', {}],
      ['garbage header', { 'stripe-signature': 'nonsense' }],
      ['wrong secret', { 'stripe-signature': await sig('whsec_wrong', t) }],
      ['body changed after signing', { 'stripe-signature': await sig(WHSEC, t) }, body.replace('invoice.paid', 'invoice.paid ')],
      ['5 minutes old plus one second', { 'stripe-signature': await sig(WHSEC, t - 301) }],
      ['from the future', { 'stripe-signature': await sig(WHSEC, t + 400) }],
    ];
    for (const [name, headers, b] of cases) {
      const res = await post(headers, b);
      expect(res.status, name).toBe(400);
      expect(JSON.stringify(await json(res)), name).not.toMatch(/whsec|order|ord_/);
    }
    expect(eventCount(w)).toBe(seen);
    expect(w.order(orderId).status).toBe('pending');
    expect((await post({ 'stripe-signature': await sig(WHSEC, t - 299) })).status).toBe(200); // inside the tolerance
  });

  it('refuses a body over 256 KiB (413) before reading it all, and a non-POST', async () => {
    const w = await billingWorld();
    const big = 'x'.repeat(WEBHOOK_MAX_BYTES + 1);
    const t = now();
    const res = await handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${await hmacHex(WHSEC, `${t}.${big}`)}` }, body: big }), w.env as never, ctx);
    expect(res.status).toBe(413);
    const lying = await handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'content-length': String(WEBHOOK_MAX_BYTES + 5) }, body: '{}' }), w.env as never, ctx);
    expect(lying.status).toBe(413);
    expect((await call(w.env, 'GET', '/api/stripe/webhook')).status).toBe(405);
    expect(eventCount(w)).toBe(0);
  });

  it('refuses a validly signed body that is not an event, and an event of the other key mode', async () => {
    const w = await billingWorld();
    const send = async (raw: string) => handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': await signStripePayload(WHSEC, raw) }, body: raw }), w.env as never, ctx);
    for (const raw of ['not json', '[]', '{}', '{"id":"evt_1"}', '{"id":"nope","type":"x","livemode":false,"data":{"object":{"id":"i"}}}', JSON.stringify({ id: 'evt_1', type: 'x', livemode: 'no', data: { object: { id: 'i' } } }), JSON.stringify({ id: 'evt_1', type: 'x', livemode: false, data: {} })]) {
      expect((await send(raw)).status, raw).toBe(400);
    }
    const live = JSON.stringify(w.fake.makeEvent('invoice.paid', { id: 'in_x' }, { livemode: true })); // the key is rk_test_
    const res = await send(live);
    expect(res.status).toBe(400);
    expect(eventCount(w)).toBe(0);
    const liveWorld = await billingWorld({ STRIPE_SECRET_KEY: 'rk_live_abcdef123456' });
    const testEvent = JSON.stringify(liveWorld.fake.makeEvent('invoice.paid', { id: 'in_x' }));
    expect((await handleApi(new Request(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': await signStripePayload(WHSEC, testEvent) }, body: testEvent }), liveWorld.env as never, ctx)).status).toBe(400);
  });

  it('answers an unknown event type 200 and does nothing', async () => {
    const w = await billingWorld();
    const res = await w.sendEvent(w.fake.makeEvent('payout.created', { id: 'po_1', object: 'payout' }));
    expect(res.status).toBe(200);
    expect(rows(w.db, 'SELECT type, status, outcome FROM billing_events')).toEqual([{ type: 'payout.created', status: 'ignored', outcome: 'ignored_type' }]);
  });
});

describe('idempotent by event id', () => {
  it('a repeated delivery does no work and the owner is emailed once', async () => {
    const { w, orderId, invoice } = await withOrder();
    const paid = w.fake.makeEvent('invoice.paid', invoice);
    const a = await w.sendEvent(paid);
    const callsAfterFirst = w.fake.calls.length;
    const b = await w.sendEvent(paid);
    const c = await w.sendEvent(paid);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(await json(b)).toEqual({ received: true, duplicate: true });
    expect(w.fake.calls.length).toBe(callsAfterFirst); // the duplicates did not even ask Stripe
    expect(w.order(orderId).status).toBe('paid');
    expect(w.ownerMails()).toHaveLength(1);
    expect(rows(w.db, 'SELECT status, attempts FROM billing_events WHERE id = ?', paid.id)).toEqual([{ status: 'done', attempts: 1 }]);
  });

  it('two different events for the same payment still notify once and pay once', async () => {
    const { w, orderId, invoice } = await withOrder();
    await Promise.all([w.sendEvent(w.fake.makeEvent('invoice.paid', invoice)), w.sendEvent(w.fake.makeEvent('invoice.paid', invoice)), w.sendEvent(w.fake.makeEvent('invoice.paid', invoice))]);
    expect(w.order(orderId).status).toBe('paid');
    expect(w.ownerMails()).toHaveLength(1);
    expect(rows(w.db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'billing.order_paid'")[0].n).toBe(1);
  });

  it('a handler that fails answers 500 so Stripe retries, and the retry is processed rather than swallowed', async () => {
    const { w, orderId, invoice } = await withOrder();
    const paid = w.fake.makeEvent('invoice.paid', invoice);
    w.fake.failNext(/\/v1\/invoices\/in_/, { status: 500, error: { type: 'api_error', message: 'down' } });
    const first = await w.sendEvent(paid);
    expect(first.status).toBe(500);
    expect(rows(w.db, 'SELECT status FROM billing_events WHERE id = ?', paid.id)[0].status).toBe('failed');
    expect(w.order(orderId).status).toBe('pending');
    const retry = await w.sendEvent(paid);
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual({ received: true });
    expect(rows(w.db, 'SELECT status, attempts FROM billing_events WHERE id = ?', paid.id)).toEqual([{ status: 'done', attempts: 2 }]);
    expect(w.order(orderId).status).toBe('paid');
  });

  it('an event stuck "processing" for over a minute is taken over; a fresh one is left to its owner', async () => {
    const { w, orderId, invoice } = await withOrder();
    const paid = w.fake.makeEvent('invoice.paid', invoice);
    w.db.sqlite.prepare("INSERT INTO billing_events (id, type, status, updated_at) VALUES (?, 'invoice.paid', 'processing', unixepoch())").run(paid.id);
    expect(await json(await w.sendEvent(paid))).toEqual({ received: true, duplicate: true });
    expect(w.order(orderId).status).toBe('pending');
    w.db.sqlite.prepare('UPDATE billing_events SET updated_at = updated_at - 120 WHERE id = ?').run(paid.id);
    expect(await json(await w.sendEvent(paid))).toEqual({ received: true });
    expect(w.order(orderId).status).toBe('paid');
  });
});

describe('events are only pointers: everything is re-read from Stripe and must agree', () => {
  it('an invoice.paid for an invoice Stripe still shows unpaid changes nothing', async () => {
    const { w, orderId, invoice } = await withOrder('requires_action');
    const forged = w.fake.makeEvent('invoice.paid', { ...invoice, status: 'paid', amount_paid: 14900 });
    expect((await w.sendEvent(forged)).status).toBe(200);
    expect(w.order(orderId)).toMatchObject({ status: 'pending', paid_at: null });
    expect(w.ownerMails()).toHaveLength(0);
  });
  it('an event naming another customer is ignored without asking Stripe anything', async () => {
    const { w, orderId, invoice } = await withOrder();
    const before = w.fake.calls.length;
    const ev = w.fake.makeEvent('invoice.paid', { ...invoice, customer: 'cus_attacker' });
    expect((await w.sendEvent(ev)).status).toBe(200);
    expect(rows(w.db, 'SELECT outcome FROM billing_events WHERE id = ?', ev.id)[0].outcome).toBe('customer_mismatch');
    expect(w.fake.calls.length).toBe(before);
    expect(w.order(orderId).status).toBe('pending');
  });
  it('an event whose invoice is not the order\'s invoice is ignored', async () => {
    const { w, orderId, invoice } = await withOrder();
    const ev = w.fake.makeEvent('invoice.paid', { ...invoice, id: 'in_other' });
    await w.sendEvent(ev);
    expect(rows(w.db, 'SELECT outcome FROM billing_events WHERE id = ?', ev.id)[0].outcome).toBe('invoice_mismatch');
    expect(w.order(orderId).status).toBe('pending');
  });
  it('when Stripe\'s own copy disagrees (customer, metadata order id, price, currency) nothing moves', async () => {
    for (const tamper of [
      (i: any) => { i.customer = 'cus_someone_else'; },
      (i: any) => { i.metadata = { ...i.metadata, order_id: 'ord_other' }; },
      (_i: any, w: World) => { [...w.fake.state.invoiceItems.values()][0]!.price.id = 'price_other'; }, // the amount collected may differ (review.test.ts); what was sold may not
      (i: any) => { i.currency = 'eur'; },
    ]) {
      const { w, orderId, invoice } = await withOrder();
      tamper(w.fake.state.invoices.get(invoice.id)!, w);
      await w.sendEvent(w.fake.makeEvent('invoice.paid', { ...invoice }));
      expect(w.order(orderId), String(tamper)).toMatchObject({ status: 'pending', paid_at: null });
      expect(w.ownerMails()).toHaveLength(0);
    }
  });
  it('an unknown order (our metadata names nothing we have) is ignored', async () => {
    const { w, invoice } = await withOrder();
    const ev = w.fake.makeEvent('invoice.paid', { ...invoice, id: 'in_zzz', metadata: { order_id: 'ord_' + 'f'.repeat(32) } });
    expect((await w.sendEvent(ev)).status).toBe(200);
    expect(rows(w.db, 'SELECT outcome FROM billing_events WHERE id = ?', ev.id)[0].outcome).toBe('unknown_order');
  });
  it('payment_failed for an invoice that was in fact paid leaves it paid (out of order)', async () => {
    const { w, orderId, invoice } = await withOrder();
    await w.sendEvent(w.fake.makeEvent('invoice.paid', invoice));
    expect(w.order(orderId).status).toBe('paid');
    await w.sendEvent(w.fake.makeEvent('invoice.payment_failed', invoice));
    await w.sendEvent(w.fake.makeEvent('invoice.payment_action_required', invoice));
    expect(w.order(orderId).status).toBe('paid');
  });
  it('payment_failed after a bad bank confirmation uses Stripe\'s own words and voids the invoice', async () => {
    const { w, orderId, invoice } = await withOrder('requires_action');
    w.fake.completeInvoiceAction(invoice.id, 'fail');
    const ev = [...w.fake.state.events.values()].find((e) => e.type === 'invoice.payment_failed')!;
    await w.sendEvent(ev);
    expect(w.order(orderId)).toMatchObject({ status: 'failed', failure_code: 'generic_decline', failure_message: 'Your card was declined.' });
    expect(w.fake.state.invoices.get(invoice.id)!.status).toBe('void');
  });
  it('a refund of a charge of another customer, or of no order of ours, changes nothing', async () => {
    const { w, orderId, invoice } = await withOrder();
    await w.sendEvent(w.fake.makeEvent('invoice.paid', invoice));
    const charge = [...w.fake.state.charges.values()][0];
    const foreign = w.fake.makeEvent('charge.refunded', { ...charge, id: 'ch_unknown', payment_intent: 'pi_unknown' });
    await w.sendEvent(foreign);
    expect(rows(w.db, 'SELECT outcome FROM billing_events WHERE id = ?', foreign.id)[0].outcome).toBe('unknown_charge');
    w.fake.state.charges.get(charge.id)!.customer = 'cus_someone_else';
    w.fake.refund(charge.id, 14900);
    const real = [...w.fake.state.events.values()].filter((e) => e.type === 'charge.refunded').at(-1)!;
    await w.sendEvent(real);
    expect(w.order(orderId)).toMatchObject({ status: 'paid', amount_refunded: 0 });
  });
  it('a refund found through the invoice when the order has not learned its charge yet', async () => {
    const { w, orderId, invoice } = await withOrder();
    await w.sendEvent(w.fake.makeEvent('invoice.paid', invoice));
    w.db.sqlite.prepare('UPDATE billing_orders SET stripe_charge_id = NULL, stripe_payment_intent_id = NULL WHERE id = ?').run(orderId);
    const charge = [...w.fake.state.charges.values()][0];
    w.fake.refund(charge.id, 14900);
    const ev = [...w.fake.state.events.values()].filter((e) => e.type === 'charge.refunded').at(-1)!;
    await w.sendEvent(ev);
    expect(w.order(orderId).status).toBe('refunded');
  });
});

describe('secrets and payloads never reach the logs', () => {
  it('logs the event id, type and outcome and nothing else, across a whole purchase', async () => {
    const w = await billingWorld();
    const domainId = w.addDomain(w.owner.workspaceId, 'acme.com');
    await w.addCard(w.owner);
    const o = await json(await w.buy(w.owner, domainId));
    await w.fake.flush();
    w.fake.refund(w.order(o.order.id).stripe_charge_id, 100);
    await w.fake.flush();
    await w.sendEvent(w.fake.makeEvent('invoice.paid', { id: 'in_x', customer: 'cus_x', metadata: {}, card: { last4: '4242' } }), { secret: 'whsec_wrong' });
    w.fake.failNext(/charges/, { status: 500, error: { type: 'api_error', message: `boom ${KEY} ${WHSEC} owner@example.com` } });
    w.fake.refund(w.order(o.order.id).stripe_charge_id, 100);
    await w.fake.flush();
    const lines = ['log', 'warn', 'error', 'info', 'debug'].flatMap((m) => (console[m as 'log'] as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? []).map((c) => c.map(String).join(' '));
    const all = lines.join('\n');
    for (const secret of [KEY, WHSEC, 'rk_test_', 'whsec_', 'owner@example.com', 'cus_', 'pm_', 'acme.com', 'Your card']) expect(all, secret).not.toContain(secret);
    expect(all, 'the card digits').not.toMatch(CARD_LAST4);
    const hooks = lines.filter((l) => l.startsWith('[billing] webhook'));
    expect(hooks.length).toBeGreaterThan(3);
    for (const l of hooks) expect(l).toMatch(/^\[billing\] webhook evt=[A-Za-z0-9_.?-]+ type=[A-Za-z0-9_.?-]+ outcome=[A-Za-z0-9_.?= -]+$/);
  });
});
