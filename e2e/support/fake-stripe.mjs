// In-memory fake of the slice of the Stripe API that the billing code uses, pinned to one API version.
// Works in-process (`createFakeStripe().fetch` as an injected fetch) and as a standalone node http server
// (`startFakeStripe`, or `node e2e/support/fake-stripe.mjs`). Plain ESM, node built-ins and web globals only.
// The API key is never stored or logged: only its prefix ('rk_test_') is kept in `fake.keySeen`.
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const STRIPE_FAKE_API_VERSION = '2025-09-30.clover';

const FORM_CT = 'application/x-www-form-urlencoded';
const CARDS = {
  ok: { brand: 'visa', last4: '4242' },
  decline: { brand: 'visa', last4: '0002' },
  requires_action: { brand: 'visa', last4: '3155' },
};

/** Parse Stripe-style bracket notation (a[b]=c, a[]=x, a[0][b]=c) into nested objects/arrays. */
export function parseStripeForm(text) {
  const root = {};
  const dec = s => decodeURIComponent(s.replace(/\+/g, ' '));
  for (const pair of String(text || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = dec(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : dec(pair.slice(eq + 1));
    const m = key.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
    if (!m) { root[key] = value; continue; }
    const segs = [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map(x => x[1])];
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const last = i === segs.length - 1;
      const next = segs[i + 1];
      if (Array.isArray(cur)) {
        if (seg === '') {
          if (last) cur.push(value);
          else { const o = next === '' || /^\d+$/.test(next) ? [] : {}; cur.push(o); cur = o; }
          continue;
        }
      }
      if (last) { cur[seg] = value; break; }
      if (cur[seg] === undefined || typeof cur[seg] !== 'object') cur[seg] = next === '' || /^\d+$/.test(next) ? [] : {};
      cur = cur[seg];
    }
  }
  return root;
}

function toHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }

/** The Stripe-Signature header value: `t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`. */
export async function signStripePayload(secret, body, tSeconds = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${tSeconds}.${body}`));
  return `t=${tSeconds},v1=${toHex(mac)}`;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

class ApiError extends Error {
  constructor(status, error) { super(error.message); this.status = status; this.error = error; }
}
const bad = (message, code, param, status = 400) => new ApiError(status, { type: 'invalid_request_error', ...(code ? { code } : {}), message, ...(param ? { param } : {}) });
const missing = (what, id) => new ApiError(404, { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}: '${id}'`, param: what === 'customer' ? 'customer' : what });
const clone = v => structuredClone(v);
const isTrue = v => v === 'true' || v === true;
const asArray = v => (v === undefined ? [] : Array.isArray(v) ? v : typeof v === 'object' ? Object.values(v) : [v]);

/**
 * @param {import('./fake-stripe.mjs').FakeStripeOptions} [opts]
 */
export function createFakeStripe(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const sec = () => Math.floor(now() / 1000);
  let counter = 0;
  const id = prefix => `${prefix}_fake${String(++counter).padStart(6, '0')}`;

  const state = {
    customers: new Map(), sessions: new Map(), setupIntents: new Map(), paymentMethods: new Map(), invoices: new Map(),
    invoiceItems: new Map(), paymentIntents: new Map(), charges: new Map(), refunds: new Map(), portalSessions: new Map(),
    prices: new Map(), events: new Map(),
  };
  const behaviors = new Map(); // payment method id -> 'ok'|'decline'|'requires_action'
  const delivered = new Set();
  const idem = new Map();
  let failures = [];
  let nextCard = null;
  let scheduled = false;
  let target = null;

  const fake = {
    state,
    calls: [],
    keySeen: [],
    deliveries: [],
    livemode: false,
    webhookSecret: opts.webhookSecret ?? 'whsec_fake',
    publicBase: opts.publicBase ?? 'https://stripe.fake',
    autoDeliver: opts.autoDeliver ?? true,
  };

  // ---- events and webhook delivery ----
  fake.makeEvent = (type, object, extra = {}) => ({
    id: id('evt'), object: 'event', api_version: STRIPE_FAKE_API_VERSION, created: sec(), livemode: fake.livemode,
    pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object: clone(object) }, ...extra,
  });
  function queue(type, object) {
    const ev = fake.makeEvent(type, object);
    state.events.set(ev.id, ev);
    schedule();
    return ev;
  }
  function schedule() {
    if (!fake.autoDeliver || !target || scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; fake.flush().catch(() => {}); }, 0);
  }
  fake.setWebhookTarget = t => { target = t; schedule(); };
  fake.deliver = async event => {
    if (!target) throw new Error('fake-stripe: no webhook target set');
    const body = JSON.stringify(event);
    const headers = { 'Content-Type': 'application/json', 'Stripe-Signature': await signStripePayload(fake.webhookSecret, body, sec()) };
    const req = new Request(typeof target === 'string' ? target : 'https://app.fake/webhooks/stripe', { method: 'POST', headers, body });
    let res;
    try { res = await (typeof target === 'string' ? fetch(req) : target(req)); }
    catch (e) { fake.deliveries.push({ eventId: event.id, type: event.type, status: 0 }); throw e; }
    fake.deliveries.push({ eventId: event.id, type: event.type, status: res.status });
    return res;
  };
  // One delivery run at a time: an explicit flush waits for a scheduled (auto) one in flight instead of returning while it is still delivering.
  let flushChain = Promise.resolve();
  fake.flush = () => {
    const run = flushChain.then(async () => {
      const out = [];
      if (!target) return out;
      for (const ev of [...state.events.values()]) {
        if (delivered.has(ev.id)) continue;
        delivered.add(ev.id);
        await fake.deliver(ev);
        out.push(fake.deliveries[fake.deliveries.length - 1]);
      }
      return out;
    });
    flushChain = run.catch(() => {});
    return run;
  };
  fake.redeliver = async eventId => {
    const ev = state.events.get(eventId);
    if (!ev) throw new Error(`fake-stripe: no such event ${eventId}`);
    return fake.deliver(ev);
  };

  // ---- object builders ----
  const base = (prefix, object, extra) => ({ id: id(prefix), object, created: sec(), livemode: fake.livemode, ...extra });

  function seedPrice(partial = {}) {
    let existing = partial.id ? state.prices.get(partial.id) : [...state.prices.values()].find(p => partial.lookup_key && p.lookup_key === partial.lookup_key);
    const pid = existing?.id ?? partial.id ?? `price_fake_${partial.lookup_key ?? ++counter}`;
    const price = {
      id: pid, object: 'price', active: true, billing_scheme: 'per_unit', currency: 'usd', lookup_key: null, metadata: {},
      product: 'prod_fake', type: 'one_time', unit_amount: 0, created: sec(), livemode: fake.livemode, ...existing, ...partial, id: pid,
    };
    price.unit_amount_decimal = String(price.unit_amount);
    state.prices.set(pid, price);
    return clone(price);
  }
  function seedDefaults() {
    seedPrice({ id: 'price_fake_fix_one_domain', lookup_key: 'rsm_fix_one_domain', unit_amount: 14900, currency: 'usd', type: 'one_time', active: true, billing_scheme: 'per_unit' });
  }
  seedDefaults();
  fake.seedPrice = seedPrice;

  function paymentMethodFor(customerId, kind) {
    const c = CARDS[kind];
    const pm = base('pm', 'payment_method', {
      type: 'card', customer: customerId,
      card: { brand: c.brand, last4: c.last4, exp_month: 12, exp_year: new Date(now()).getUTCFullYear() + 3, funding: 'credit', country: 'US' },
    });
    state.paymentMethods.set(pm.id, pm);
    behaviors.set(pm.id, kind);
    return pm;
  }

  function invoiceTotal(inv) {
    return [...state.invoiceItems.values()].filter(i => i.invoice === inv.id).reduce((s, i) => s + i.amount, 0);
  }
  function syncTotals(inv) {
    const t = invoiceTotal(inv);
    inv.subtotal = t; inv.total = t;
    inv.amount_due = inv.status === 'paid' ? t : t;
    inv.amount_remaining = inv.status === 'paid' ? 0 : t;
  }
  function linesOf(inv) {
    const data = [...state.invoiceItems.values()].filter(i => i.invoice === inv.id).map(i => ({
      id: `il_${i.id}`, object: 'line_item', amount: i.amount, currency: i.currency, description: i.description, quantity: i.quantity ?? 1, metadata: clone(i.metadata ?? {}),
      pricing: i.price ? { type: 'price_details', price_details: { price: i.price.id, product: i.price.product }, unit_amount_decimal: String(i.price.unit_amount) } : { type: 'price_details', price_details: { price: null, product: null } },
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: i.id } },
    }));
    return { object: 'list', data, has_more: false, url: `/v1/invoices/${inv.id}/lines` };
  }
  function invoiceOut(inv, expand = []) {
    const out = clone(inv);
    delete out.payments;
    out.lines = linesOf(inv);
    if (expand.some(e => e === 'payments' || e.startsWith('payments.'))) {
      const full = expand.includes('payments.data.payment.payment_intent');
      out.payments = {
        object: 'list', has_more: false, url: `/v1/invoice_payments?invoice=${inv.id}`,
        data: inv.payments.map(p => ({
          ...clone(p), payment: { type: 'payment_intent', payment_intent: full ? clone(state.paymentIntents.get(p.payment.payment_intent)) : p.payment.payment_intent },
        })),
      };
    }
    return out;
  }
  function customerOut(c, expand = []) {
    if (c.deleted) return { id: c.id, object: 'customer', deleted: true };
    const out = clone(c);
    if (expand.includes('invoice_settings.default_payment_method') && out.invoice_settings.default_payment_method) {
      out.invoice_settings.default_payment_method = clone(state.paymentMethods.get(out.invoice_settings.default_payment_method));
    }
    return out;
  }

  /** Find or create the PaymentIntent of this invoice (the open invoice payment, if any). */
  function intentFor(inv, pmId) {
    const open = inv.payments.find(p => p.status === 'open');
    if (open) return state.paymentIntents.get(open.payment.payment_intent);
    const pi = base('pi', 'payment_intent', {
      amount: inv.amount_due, currency: inv.currency, customer: inv.customer, payment_method: pmId ?? null,
      status: 'requires_payment_method', latest_charge: null, last_payment_error: null, metadata: {},
    });
    state.paymentIntents.set(pi.id, pi);
    inv.payments.push({ id: id('inpay'), object: 'invoice_payment', invoice: inv.id, payment: { type: 'payment_intent', payment_intent: pi.id }, status: 'open', amount_paid: null, amount_requested: inv.amount_due, created: sec(), livemode: fake.livemode });
    return pi;
  }
  function markPaid(inv, pi) {
    const ch = base('ch', 'charge', {
      amount: pi.amount, amount_refunded: 0, refunded: false, currency: pi.currency, customer: pi.customer, payment_intent: pi.id,
      payment_method: pi.payment_method, status: 'succeeded', paid: true, metadata: {},
    });
    state.charges.set(ch.id, ch);
    pi.status = 'succeeded'; pi.latest_charge = ch.id; pi.last_payment_error = null;
    const ip = inv.payments.find(p => p.payment.payment_intent === pi.id);
    ip.status = 'paid'; ip.amount_paid = pi.amount;
    inv.status = 'paid'; inv.amount_paid = pi.amount; inv.amount_remaining = 0;
    inv.status_transitions.paid_at = sec();
    queue('invoice.paid', invoiceOut(inv));
    queue('invoice.payment_succeeded', invoiceOut(inv));
    return ch;
  }

  // ---- test controls ----
  fake.setNextCard = kind => { if (!CARDS[kind]) throw new Error(`fake-stripe: unknown card kind ${kind}`); nextCard = kind; };
  fake.completeCheckout = (sessionId, o = {}) => {
    const s = state.sessions.get(sessionId);
    if (!s) throw new Error(`fake-stripe: no such session ${sessionId}`);
    if (s.status !== 'open') throw new Error(`fake-stripe: session ${sessionId} is ${s.status}`);
    const kind = o.card ?? nextCard ?? 'ok';
    if (kind === 'cancel') return s.cancel_url;
    if (!CARDS[kind]) throw new Error(`fake-stripe: unknown card kind ${kind}`);
    if (!o.card || o.card === nextCard) nextCard = null;
    const pm = paymentMethodFor(s.customer, kind);
    const si = base('seti', 'setup_intent', { status: 'succeeded', customer: s.customer, payment_method: pm.id, usage: 'off_session', metadata: clone(s._setupMetadata ?? {}) });
    state.setupIntents.set(si.id, si);
    s.status = 'complete'; s.setup_intent = si.id;
    queue('checkout.session.completed', sessionOut(s));
    return s.success_url.split('{CHECKOUT_SESSION_ID}').join(s.id);
  };
  fake.completeInvoiceAction = (invoiceId, action) => {
    const inv = state.invoices.get(invoiceId);
    if (!inv) throw new Error(`fake-stripe: no such invoice ${invoiceId}`);
    if (inv.status !== 'open') throw new Error(`fake-stripe: invoice ${invoiceId} is ${inv.status}`);
    const cust = state.customers.get(inv.customer);
    const pi = intentFor(inv, cust?.invoice_settings?.default_payment_method);
    if (action === 'succeed') markPaid(inv, pi);
    else if (action === 'fail') {
      pi.status = 'requires_payment_method';
      pi.last_payment_error = { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.', payment_method: pi.payment_method };
      queue('invoice.payment_failed', invoiceOut(inv));
    } else throw new Error(`fake-stripe: unknown action ${action}`);
    return invoiceOut(inv);
  };
  fake.refund = (chargeId, amountMinor) => {
    const ch = state.charges.get(chargeId);
    if (!ch) throw new Error(`fake-stripe: no such charge ${chargeId}`);
    const amount = amountMinor ?? ch.amount - ch.amount_refunded;
    if (!(amount > 0) || amount > ch.amount - ch.amount_refunded) throw new Error('fake-stripe: refund amount exceeds the refundable balance');
    const re = base('re', 'refund', { amount, currency: ch.currency, charge: ch.id, payment_intent: ch.payment_intent, status: 'succeeded' });
    state.refunds.set(re.id, re);
    ch.amount_refunded += amount;
    ch.refunded = ch.amount_refunded === ch.amount;
    queue('charge.refunded', ch);
    return clone(re);
  };
  /** Credit (a negative balance, minor units) that Stripe applies to the customer's next finalized invoice. */
  fake.setCustomerBalance = (cid, balance) => {
    const c = state.customers.get(cid);
    if (!c || c.deleted) throw new Error(`fake-stripe: no such customer ${cid}`);
    c.balance = balance;
  };
  fake.deleteCustomer = cid => {
    if (!state.customers.get(cid)) throw new Error(`fake-stripe: no such customer ${cid}`);
    const stub = { id: cid, object: 'customer', deleted: true };
    state.customers.set(cid, stub);
    queue('customer.deleted', stub);
  };
  fake.failNext = (matcher, { status = 500, error = {} } = {}) => {
    failures.push({ matcher, status, error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message: 'Injected failure.', ...error } });
  };
  fake.reset = () => {
    for (const m of Object.values(state)) m.clear();
    behaviors.clear(); delivered.clear(); idem.clear();
    failures = []; nextCard = null; counter = 0;
    fake.calls.length = 0; fake.keySeen.length = 0; fake.deliveries.length = 0;
    seedDefaults();
  };

  function sessionOut(s, expand = []) {
    const out = clone(s);
    for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
    if (expand.includes('setup_intent') && out.setup_intent) out.setup_intent = clone(state.setupIntents.get(out.setup_intent));
    return out;
  }

  // ---- routing ----
  const need = (form, name) => {
    if (form[name] === undefined || form[name] === '') throw bad(`Missing required param: ${name}.`, 'parameter_missing', name);
    return form[name];
  };
  const customerOf = cid => {
    const c = state.customers.get(cid);
    if (!c || c.deleted) throw missing('customer', cid);
    return c;
  };
  const mergeMeta = (target, meta) => {
    for (const [k, v] of Object.entries(meta ?? {})) { if (v === '') delete target[k]; else target[k] = v; }
  };
  const list = (data, url) => ({ object: 'list', data, has_more: false, url });
  const ok = body => ({ status: 200, body });

  function route(method, path, q, form) {
    let m;
    const expand = asArray((method === 'GET' ? q : form).expand);

    if (path === '/v1/customers' && method === 'POST') {
      const c = base('cus', 'customer', {
        email: form.email ?? null, name: form.name ?? null, metadata: {}, description: null, balance: 0,
        invoice_settings: { default_payment_method: null, custom_fields: null, footer: null, rendering_options: null },
      });
      mergeMeta(c.metadata, form.metadata);
      state.customers.set(c.id, c);
      return ok(customerOut(c));
    }
    if ((m = path.match(/^\/v1\/customers\/([^/]+)$/))) {
      const c = state.customers.get(m[1]);
      if (!c) throw missing('customer', m[1]);
      if (method === 'GET') return ok(customerOut(c, expand));
      if (method === 'POST') {
        if (c.deleted) throw missing('customer', m[1]);
        for (const k of ['email', 'name', 'description']) if (form[k] !== undefined) c[k] = form[k] === '' ? null : form[k];
        mergeMeta(c.metadata, form.metadata);
        const dpm = form.invoice_settings?.default_payment_method;
        if (dpm !== undefined) {
          if (dpm !== '' && !state.paymentMethods.has(dpm)) throw missing('payment_method', dpm);
          c.invoice_settings.default_payment_method = dpm === '' ? null : dpm;
        }
        return ok(customerOut(c, expand));
      }
    }

    if (path === '/v1/checkout/sessions' && method === 'POST') {
      if (form.mode !== 'setup') throw bad('Only mode=setup is supported by this fake.', 'parameter_invalid_enum', 'mode');
      const cid = need(form, 'customer'); const success = need(form, 'success_url'); const cancel = need(form, 'cancel_url');
      customerOf(cid);
      const s = base('cs_test', 'checkout.session', {
        mode: 'setup', status: 'open', customer: cid, success_url: success, cancel_url: cancel, client_reference_id: form.client_reference_id ?? null,
        metadata: clone(form.metadata ?? {}), payment_method_types: asArray(form.payment_method_types), setup_intent: null, url: null,
        _setupMetadata: form.setup_intent_data?.metadata,
      });
      s.url = `${fake.publicBase}/pay/${s.id}`;
      state.sessions.set(s.id, s);
      return ok(sessionOut(s));
    }
    if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && method === 'GET') {
      const s = state.sessions.get(m[1]);
      if (!s) throw missing('checkout.session', m[1]);
      return ok(sessionOut(s, expand));
    }

    if (path === '/v1/prices' && method === 'GET') {
      const keys = asArray(q.lookup_keys);
      let rows = [...state.prices.values()];
      if (keys.length) rows = rows.filter(p => keys.includes(p.lookup_key));
      if (q.active !== undefined) rows = rows.filter(p => p.active === isTrue(q.active));
      const limit = q.limit ? Number(q.limit) : 10;
      const out = list(rows.slice(0, limit).map(clone), '/v1/prices');
      out.has_more = rows.length > limit;
      return ok(out);
    }

    if (path === '/v1/invoices' && method === 'POST') {
      const cid = need(form, 'customer');
      customerOf(cid);
      const inv = base('in', 'invoice', {
        customer: cid, status: 'draft', collection_method: form.collection_method ?? 'charge_automatically',
        auto_advance: form.auto_advance === undefined ? true : isTrue(form.auto_advance), currency: form.currency ?? 'usd',
        description: form.description ?? null, metadata: clone(form.metadata ?? {}), payment_settings: clone(form.payment_settings ?? {}),
        hosted_invoice_url: null, subtotal: 0, total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0,
        status_transitions: { finalized_at: null, paid_at: null, voided_at: null, marked_uncollectible_at: null }, payments: [],
      });
      state.invoices.set(inv.id, inv);
      queue('invoice.created', invoiceOut(inv));
      return ok(invoiceOut(inv));
    }
    if (path === '/v1/invoiceitems' && method === 'POST') {
      const cid = need(form, 'customer'); const iid = need(form, 'invoice');
      customerOf(cid);
      const inv = state.invoices.get(iid);
      if (!inv) throw missing('invoice', iid);
      if (inv.customer !== cid) throw bad(`Invoice ${iid} does not belong to customer ${cid}.`, 'invoice_customer_mismatch', 'invoice');
      if (inv.status !== 'draft') throw bad('You can only add invoice items to a draft invoice.', 'invoice_not_editable', 'invoice');
      let amount; let currency = form.currency ?? inv.currency; let price = null;
      if (form.price !== undefined) {
        price = state.prices.get(form.price);
        if (!price) throw missing('price', form.price);
        amount = price.unit_amount * (form.quantity ? Number(form.quantity) : 1); currency = price.currency;
      } else if (form.amount !== undefined) amount = Number(form.amount);
      else throw bad('Missing required param: price.', 'parameter_missing', 'price');
      const item = base('ii', 'invoiceitem', {
        customer: cid, invoice: iid, amount, currency, quantity: form.quantity ? Number(form.quantity) : 1, description: form.description ?? null, metadata: clone(form.metadata ?? {}),
        price: price ? clone(price) : null, date: sec(),
      });
      state.invoiceItems.set(item.id, item);
      syncTotals(inv);
      return ok(clone(item));
    }
    if ((m = path.match(/^\/v1\/invoiceitems\/([^/]+)$/)) && method === 'DELETE') {
      const item = state.invoiceItems.get(m[1]);
      if (!item) throw missing('invoiceitem', m[1]);
      const inv = item.invoice ? state.invoices.get(item.invoice) : null;
      if (inv && inv.status !== 'draft') throw bad('You can only delete invoice items on a draft invoice.', 'invoice_not_editable');
      state.invoiceItems.delete(item.id);
      if (inv) syncTotals(inv);
      return ok({ id: item.id, object: 'invoiceitem', deleted: true });
    }
    if ((m = path.match(/^\/v1\/invoices\/([^/]+)(?:\/(finalize|pay|void))?$/))) {
      const inv = state.invoices.get(m[1]);
      if (!inv) throw missing('invoice', m[1]);
      const action = m[2];
      if (!action && method === 'GET') return ok(invoiceOut(inv, expand));
      if (!action && method === 'DELETE') {
        if (inv.status !== 'draft') throw bad(`You can only delete draft invoices; this one is ${inv.status}.`, 'invoice_not_editable');
        for (const [iid, item] of [...state.invoiceItems]) if (item.invoice === inv.id) state.invoiceItems.delete(iid);
        state.invoices.delete(inv.id);
        return ok({ id: inv.id, object: 'invoice', deleted: true });
      }
      if (action && method === 'POST') return invoiceAction(inv, action, form);
    }
    if (path === '/v1/invoice_payments' && method === 'GET') {
      const pi = q.payment?.payment_intent;
      let rows = [];
      for (const inv of state.invoices.values()) for (const p of inv.payments) rows.push(p);
      if (q.payment?.type) rows = rows.filter(p => p.payment.type === q.payment.type);
      if (pi) rows = rows.filter(p => p.payment.payment_intent === pi);
      if (q.invoice) rows = rows.filter(p => p.invoice === q.invoice);
      const limit = q.limit ? Number(q.limit) : 10;
      const out = list(rows.slice(0, limit).map(clone), '/v1/invoice_payments');
      out.has_more = rows.length > limit;
      return ok(out);
    }

    if ((m = path.match(/^\/v1\/charges\/([^/]+)$/)) && method === 'GET') {
      const ch = state.charges.get(m[1]);
      if (!ch) throw missing('charge', m[1]);
      return ok(clone(ch));
    }
    if ((m = path.match(/^\/v1\/payment_methods\/([^/]+)$/)) && method === 'GET') {
      const pm = state.paymentMethods.get(m[1]);
      if (!pm) throw missing('payment_method', m[1]);
      return ok(clone(pm));
    }
    if (path === '/v1/billing_portal/sessions' && method === 'POST') {
      const cid = need(form, 'customer'); const ret = need(form, 'return_url');
      customerOf(cid);
      const ps = base('bps', 'billing_portal.session', { customer: cid, return_url: ret, url: null });
      ps.url = `${fake.publicBase}/portal/${ps.id}`;
      state.portalSessions.set(ps.id, ps);
      return ok(clone(ps));
    }

    throw new ApiError(404, { type: 'invalid_request_error', code: 'resource_missing', message: `Unrecognized request URL (${method}: ${path}).` });
  }

  function invoiceAction(inv, action, form) {
    if (action === 'finalize') {
      if (inv.status !== 'draft') throw bad("This invoice is already finalized, you can't re-finalize a non-draft invoice.", 'invoice_not_draft');
      syncTotals(inv);
      // A credit on the customer's balance is applied when the invoice is finalized: what is due drops, what is sold does not.
      const cust = state.customers.get(inv.customer);
      const credit = cust && cust.balance < 0 ? Math.min(-cust.balance, inv.total) : 0;
      if (credit) { cust.balance += credit; inv.starting_balance = -credit; inv.amount_due = inv.total - credit; inv.amount_remaining = inv.amount_due; }
      inv.status = 'open';
      inv.hosted_invoice_url = `${fake.publicBase}/i/${inv.id}`;
      inv.status_transitions.finalized_at = sec();
      if (form.auto_advance !== undefined) inv.auto_advance = isTrue(form.auto_advance);
      queue('invoice.finalized', invoiceOut(inv));
      return ok(invoiceOut(inv));
    }
    if (action === 'void') {
      if (inv.status !== 'open') throw bad(`You can only void an open invoice; this one is ${inv.status}.`, 'invoice_not_open');
      inv.status = 'void'; inv.amount_remaining = 0;
      inv.status_transitions.voided_at = sec();
      queue('invoice.voided', invoiceOut(inv));
      return ok(invoiceOut(inv));
    }
    // pay
    if (inv.status !== 'open') throw bad(`This invoice can't be paid because it is ${inv.status}.`, 'invoice_not_open');
    if (!isTrue(form.off_session)) throw bad('off_session=true is required to pay an invoice without the customer present.', 'parameter_missing', 'off_session');
    const cust = state.customers.get(inv.customer);
    const pmId = cust?.invoice_settings?.default_payment_method;
    if (!pmId) throw bad('This customer has no attached payment source or default payment method.', 'invoice_no_payment_method');
    const behavior = behaviors.get(pmId) ?? 'ok';
    const pi = intentFor(inv, pmId);
    pi.payment_method = pmId;
    if (behavior === 'ok') { markPaid(inv, pi); return ok(invoiceOut(inv)); }
    if (behavior === 'decline') {
      pi.status = 'requires_payment_method';
      pi.last_payment_error = { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.', payment_method: clone(state.paymentMethods.get(pmId)) };
      queue('invoice.payment_failed', invoiceOut(inv));
      throw new ApiError(402, { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.', payment_intent: clone(pi) });
    }
    pi.status = 'requires_action';
    // Real Stripe sends invoice.payment_failed as well while the PaymentIntent is still waiting for the buyer (3-D Secure); either may arrive first.
    queue('invoice.payment_action_required', invoiceOut(inv));
    queue('invoice.payment_failed', invoiceOut(inv));
    throw new ApiError(402, { type: 'invalid_request_error', code: 'invoice_payment_intent_requires_action', message: 'This payment requires additional user action before it can be completed successfully.', payment_intent: clone(pi) });
  }

  // ---- HTTP entry ----
  const jsonRes = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Request-Id': `req_fake${counter}`, ...extra } });

  fake.handle = async request => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    const query = parseStripeForm(url.search.slice(1));
    const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
    const ct = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const idemKey = request.headers.get('idempotency-key');
    const auth = request.headers.get('authorization');
    const version = request.headers.get('stripe-version');
    const formOk = !text || ct === FORM_CT;
    const form = method === 'POST' && formOk ? parseStripeForm(text) : {};
    fake.calls.push({ method, path, query, form, headers: { idempotencyKey: idemKey, stripeVersion: version, hasAuth: Boolean(auth) } });

    const fail = (status, error) => jsonRes(status, { error });
    try {
      const fi = failures.findIndex(f => (f.matcher instanceof RegExp ? f.matcher.test(`${method} ${path}`) : f.matcher === `${method} ${path}`));
      if (fi >= 0) { const f = failures.splice(fi, 1)[0]; return fail(f.status, f.error); }

      const km = auth?.match(/^Bearer ((?:rk|sk)_(?:test|live)_)\S+$/);
      if (!auth) return fail(401, { type: 'invalid_request_error', message: 'You did not provide an API key. Provide your API key in the Authorization header using Bearer auth.' });
      if (!km) return fail(401, { type: 'invalid_request_error', message: 'Invalid API Key provided.' });
      fake.keySeen.push(km[1]);
      if (version !== STRIPE_FAKE_API_VERSION) {
        return fail(400, { type: 'invalid_request_error', code: 'api_version_invalid', message: `Invalid Stripe API version: ${version ?? '(none)'}. This fake only accepts ${STRIPE_FAKE_API_VERSION}.` });
      }
      if (!path.startsWith('/v1/')) return fail(404, { type: 'invalid_request_error', code: 'resource_missing', message: `Unrecognized request URL (${method}: ${path}).` });
      if (method === 'POST' && !formOk) return fail(400, { type: 'invalid_request_error', message: `Invalid content type ${ct}: POST bodies must be ${FORM_CT}.` });

      const scope = `${km[1]}:${idemKey}`;
      const fp = canonical({ method, path, form });
      if (method === 'POST' && idemKey) {
        const prev = idem.get(scope);
        if (prev) {
          if (prev.fp !== fp) return fail(400, { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' });
          return jsonRes(prev.status, prev.body, { 'Idempotent-Replayed': 'true', 'Idempotency-Key': idemKey });
        }
      }
      let result;
      try { result = route(method, path, query, form); }
      catch (e) { if (e instanceof ApiError) result = { status: e.status, body: { error: e.error } }; else throw e; }
      if (method === 'POST' && idemKey) idem.set(scope, { fp, status: result.status, body: result.body });
      return jsonRes(result.status, result.body, idemKey && method === 'POST' ? { 'Idempotency-Key': idemKey } : {});
    } catch (e) {
      return fail(500, { type: 'api_error', message: `fake-stripe internal error: ${e?.message ?? e}` });
    }
  };
  fake.fetch = (input, init) => fake.handle(new Request(input, init));
  return fake;
}

// ---- standalone server ----
const html = (title, body, status = 200) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function pages(fake, request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const p = url.pathname;
  let m;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const readJson = async () => { try { return JSON.parse((await request.text()) || '{}'); } catch { return {}; } };

  if (p === '/__state' && method === 'GET') {
    const counts = Object.fromEntries(Object.entries(fake.state).map(([k, v]) => [k, v.size]));
    return json({ counts, calls: fake.calls, keySeen: fake.keySeen, deliveries: fake.deliveries });
  }
  if (p === '/__reset' && method === 'POST') { fake.reset(); return json({ ok: true }); }
  if (p === '/__next-card' && method === 'POST') {
    try { fake.setNextCard((await readJson()).kind); return json({ ok: true }); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (p === '/__flush' && method === 'POST') { try { return json({ delivered: await fake.flush() }); } catch (e) { return json({ error: e.message }, 502); } }
  if (p === '/__refund' && method === 'POST') {
    const b = await readJson();
    try { return json(fake.refund(b.charge, b.amount === undefined ? undefined : Number(b.amount))); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (p === '/__complete-invoice' && method === 'POST') {
    const b = await readJson();
    try { return json(fake.completeInvoiceAction(b.invoice, b.result)); } catch (e) { return json({ error: e.message }, 400); }
  }

  if ((m = p.match(/^\/pay\/([^/]+)(\/complete)?$/)) && method === 'GET') {
    const s = fake.state.sessions.get(m[1]);
    if (!s) return html('Fake Stripe Checkout', '<p>Unknown session.</p>', 404);
    if (!m[2]) {
      const b = `/pay/${esc(s.id)}/complete`;
      return html('Fake Stripe Checkout', `<p>Save a card (session ${esc(s.id)}, ${esc(s.status)}).</p><ul>` +
        `<li><a href="${b}?card=ok">Use test card 4242</a></li><li><a href="${b}?card=decline">Card that is declined</a></li>` +
        `<li><a href="${b}?card=requires_action">Card that needs authentication</a></li><li><a href="${b}?card=cancel">Cancel</a></li></ul>`);
    }
    try {
      const to = fake.completeCheckout(s.id, { card: url.searchParams.get('card') ?? 'ok' });
      return new Response(null, { status: 303, headers: { Location: to } });
    } catch (e) { return html('Fake Stripe Checkout', `<p>${esc(e.message)}</p>`, 400); }
  }
  if ((m = p.match(/^\/i\/([^/]+)(\/complete)?$/)) && method === 'GET') {
    const inv = fake.state.invoices.get(m[1]);
    if (!inv) return html('Fake hosted invoice', '<p>Unknown invoice.</p>', 404);
    if (!m[2]) {
      return html('Fake hosted invoice', `<p>Invoice ${esc(inv.id)} (${esc(inv.status)}), amount due ${inv.amount_due} ${esc(inv.currency)}.</p>` +
        `<a href="/i/${esc(inv.id)}/complete?result=succeed">Pay (authentication succeeds)</a> <a href="/i/${esc(inv.id)}/complete?result=fail">Pay (authentication fails)</a>`);
    }
    const result = url.searchParams.get('result');
    try {
      fake.completeInvoiceAction(inv.id, result);
      return html(result === 'succeed' ? 'Payment succeeded' : 'Payment failed', '<p>You can close this page.</p>');
    } catch (e) { return html('Fake hosted invoice', `<p>${esc(e.message)}</p>`, 400); }
  }
  if ((m = p.match(/^\/portal\/([^/]+)$/)) && method === 'GET') return html('Fake billing portal', `<p>Portal session ${esc(m[1])}.</p>`);
  return null;
}

/**
 * Start the fake as an http server. `port: 0` picks a free one; `publicBase` defaults to the server's own url.
 * @param {import('./fake-stripe.mjs').StartFakeStripeOptions} [o]
 */
export async function startFakeStripe({ port = 0, host = '127.0.0.1', webhookUrl, ...rest } = {}) {
  const fake = createFakeStripe(rest);
  if (webhookUrl) fake.setWebhookTarget(webhookUrl);
  const server = http.createServer((req, res) => {
    (async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) || !body.length ? undefined : body });
      const response = (await pages(fake, request)) ?? (await fake.handle(request));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: String(e?.message ?? e) } })); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  const url = `http://${host}:${actual}`;
  if (!rest.publicBase) fake.publicBase = url;
  return { url, port: actual, fake, close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startFakeStripe({ port: Number(process.env.PORT) || 8789, webhookUrl: process.env.WEBHOOK_URL || undefined, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined });
  console.log(`fake Stripe listening on ${s.url} (api ${STRIPE_FAKE_API_VERSION}${process.env.WEBHOOK_URL ? `, webhooks -> ${process.env.WEBHOOK_URL}` : ''})`);
}
