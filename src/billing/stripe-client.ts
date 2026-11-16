// The only place the Worker talks to api.stripe.com. Plain fetch with form encoding, no SDK: the calls are few and fixed, the
// Idempotency-Key and the pinned API version need exact control, and the Stripe key must not travel through a large dependency.
//
// The key lives in a private field: it never appears in errors, JSON, `inspect` output or logs. Errors carry Stripe's customer-safe
// `message` and codes, never the request, the headers or the key.
import { STRIPE_API_VERSION, stripeApiBase } from './config';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly code?: string,
    readonly declineCode?: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = 'StripeError';
  }
  /** The payment was refused for a card reason (declined, expired, wrong CVC…): the buyer can fix it with another card. */
  get isCardError(): boolean { return this.type === 'card_error'; }
  get isNotFound(): boolean { return this.status === 404 || this.code === 'resource_missing'; }
}
/** The request produced no usable answer (network, timeout, an answer that is not JSON). */
export class StripeNetworkError extends Error {
  constructor(message = 'Stripe could not be reached') { super(message); this.name = 'StripeNetworkError'; }
}

type Form = { [key: string]: FormValue };
type FormValue = string | number | boolean | null | undefined | FormValue[] | Form;

/** Stripe's bracket notation: a[b]=c, arrays of scalars a[]=x, arrays of objects a[0][b]=c. */
export function encodeForm(params: Form): string {
  const out: string[] = [];
  const add = (key: string, v: FormValue): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => add(typeof item === 'object' && item !== null ? `${key}[${i}]` : `${key}[]`, item));
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join('&');
}

export interface StripeObject { id: string; object?: string; [k: string]: unknown }

export interface StripeClientOptions { fetch?: typeof fetch; apiBase?: string | null; timeoutMs?: number }

export class StripeClient {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeout: number;

  constructor(key: string, opts: StripeClientOptions = {}) {
    this.#key = key;
    this.#fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.#base = stripeApiBase(opts.apiBase);
    this.#timeout = opts.timeoutMs ?? 15_000;
  }
  toJSON() { return { stripe: 'client' }; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return 'StripeClient {}'; }

  async #call<T = StripeObject>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Form = {}, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#key}`, 'Stripe-Version': STRIPE_API_VERSION };
    let url = `${this.#base}${path}`;
    let body: string | undefined;
    if (method === 'GET' || method === 'DELETE') {
      const q = encodeForm(params);
      if (q) url += `?${q}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params);
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    }
    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeout) });
    } catch {
      throw new StripeNetworkError();
    }
    let json: unknown;
    try { json = await res.json(); } catch { throw new StripeNetworkError(`Stripe answered ${res.status} without JSON`); }
    if (!res.ok) {
      const e = (json as { error?: { message?: string; type?: string; code?: string; decline_code?: string; param?: string } })?.error ?? {};
      throw new StripeError((e.message ?? `Stripe error ${res.status}`).slice(0, 300), res.status, e.type ?? 'api_error', e.code, e.decline_code, e.param);
    }
    return json as T;
  }

  // ── Customers ───────────────────────────────────────────────
  /** `attempt` > 0 only after the customer a previous key returned turned out to be deleted (a key replays its answer for 24 hours). */
  createCustomer(p: { workspaceId: string; email: string; name: string; attempt?: number }) {
    return this.#call('POST', '/v1/customers', { email: p.email, name: p.name, metadata: { workspace_id: p.workspaceId } }, `rsm-cust-${p.workspaceId}${p.attempt ? `-${p.attempt}` : ''}`);
  }
  retrieveCustomer(id: string) {
    return this.#call('GET', `/v1/customers/${enc(id)}`, { expand: ['invoice_settings.default_payment_method'] });
  }
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string) {
    return this.#call('POST', `/v1/customers/${enc(customerId)}`, { invoice_settings: { default_payment_method: paymentMethodId } }, `rsm-default-${customerId}-${paymentMethodId}`);
  }

  // ── Checkout (setup) and the billing portal ─────────────────
  createSetupSession(p: { ref: string; customerId: string; workspaceId: string; purpose: string; successUrl: string; cancelUrl: string }) {
    return this.#call('POST', '/v1/checkout/sessions', {
      mode: 'setup',
      payment_method_types: ['card'],
      customer: p.customerId,
      client_reference_id: p.workspaceId,
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      metadata: { workspace_id: p.workspaceId, purpose: p.purpose, checkout_ref: p.ref },
      setup_intent_data: { metadata: { workspace_id: p.workspaceId } },
    }, `rsm-cs-${p.ref}`);
  }
  retrieveCheckoutSession(id: string) {
    return this.#call('GET', `/v1/checkout/sessions/${enc(id)}`, { expand: ['setup_intent'] });
  }
  createPortalSession(p: { customerId: string; returnUrl: string }) {
    return this.#call('POST', '/v1/billing_portal/sessions', { customer: p.customerId, return_url: p.returnUrl });
  }

  // ── Prices ──────────────────────────────────────────────────
  listPrices(lookupKey: string) {
    return this.#call<{ data: StripeObject[] }>('GET', '/v1/prices', { lookup_keys: [lookupKey], active: true, limit: 2 });
  }

  // ── Invoices (the charge) ───────────────────────────────────
  createInvoice(p: { orderId: string; workspaceId: string; customerId: string; currency: string; domain: string; offer: string; description: string }) {
    return this.#call('POST', '/v1/invoices', {
      customer: p.customerId,
      collection_method: 'charge_automatically',
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      currency: p.currency,
      description: p.description,
      payment_settings: { payment_method_types: ['card'] },
      metadata: { order_id: p.orderId, workspace_id: p.workspaceId, domain: p.domain, offer: p.offer },
    }, `rsm-${p.orderId}-invoice`);
  }
  createInvoiceItem(p: { orderId: string; customerId: string; invoiceId: string; priceId: string; description: string }) {
    return this.#call('POST', '/v1/invoiceitems', { customer: p.customerId, invoice: p.invoiceId, price: p.priceId, description: p.description, metadata: { order_id: p.orderId } }, `rsm-${p.orderId}-item`);
  }
  /** An item on a draft invoice (deleting a draft invoice must not leave its item to land on the customer's next one). */
  deleteInvoiceItem(id: string) {
    return this.#call('DELETE', `/v1/invoiceitems/${enc(id)}`);
  }
  finalizeInvoice(orderId: string, invoiceId: string) {
    return this.#call('POST', `/v1/invoices/${enc(invoiceId)}/finalize`, { auto_advance: false }, `rsm-${orderId}-finalize`);
  }
  payInvoice(orderId: string, invoiceId: string) {
    return this.#call('POST', `/v1/invoices/${enc(invoiceId)}/pay`, { off_session: true }, `rsm-${orderId}-pay`);
  }
  voidInvoice(orderId: string, invoiceId: string) {
    return this.#call('POST', `/v1/invoices/${enc(invoiceId)}/void`, {}, `rsm-${orderId}-void`);
  }
  /** A draft invoice (one that never got finalized) cannot be voided, only deleted. */
  deleteInvoice(id: string) {
    return this.#call('DELETE', `/v1/invoices/${enc(id)}`);
  }
  retrieveInvoice(id: string) {
    return this.#call('GET', `/v1/invoices/${enc(id)}`, { expand: ['payments.data.payment.payment_intent'] });
  }
  // ── Subscriptions (pay as you go: one subscription per workspace, one item, quantity = billable domains) ──
  /**
   * The workspace's subscription. Quantity may be 0 (Stripe keeps it active with a $0 first invoice); additions and removals later prorate onto the next
   * invoice, so nothing is charged at the click. `error_if_incomplete`: a card that cannot pay fails here instead of leaving a half-made subscription.
   */
  createSubscription(p: { workspaceId: string; revision: number; customerId: string; priceId: string; quantity: number }) {
    return this.#call('POST', '/v1/subscriptions', {
      customer: p.customerId,
      items: [{ price: p.priceId, quantity: p.quantity }],
      collection_method: 'charge_automatically',
      payment_behavior: 'error_if_incomplete',
      proration_behavior: 'create_prorations',
      metadata: { workspace_id: p.workspaceId },
    }, `rsm-sub-${p.workspaceId}-${p.revision}`);
  }
  retrieveSubscription(id: string) {
    return this.#call('GET', `/v1/subscriptions/${enc(id)}`, { expand: ['latest_invoice'] });
  }
  /** The ONLY write of a quantity. The key names workspace, item, target and the lease's revision: a retry repeats it, a later change gets a new one. */
  setItemQuantity(p: { workspaceId: string; revision: number; itemId: string; quantity: number }) {
    return this.#call('POST', `/v1/subscription_items/${enc(p.itemId)}`, { quantity: p.quantity, proration_behavior: 'create_prorations' }, `rsm-qty-${p.workspaceId}-${p.itemId}-${p.quantity}-${p.revision}`);
  }
  /** Cancel now (a deleted workspace): Stripe's default, no refund of the unused period. */
  cancelSubscription(id: string) {
    return this.#call('DELETE', `/v1/subscriptions/${enc(id)}`);
  }
  /** What the next invoice will be if the subscription item changes (read only). */
  previewInvoice(p: { customerId: string; subscriptionId: string; itemId: string; quantity: number }) {
    return this.#call('POST', '/v1/invoices/create_preview', { customer: p.customerId, subscription: p.subscriptionId, subscription_details: { items: [{ id: p.itemId, quantity: p.quantity }] } });
  }
  /** The upcoming invoice as it stands (read only). */
  upcomingInvoice(p: { customerId: string; subscriptionId: string }) {
    return this.#call('POST', '/v1/invoices/create_preview', { customer: p.customerId, subscription: p.subscriptionId });
  }

  retrieveCharge(id: string) {
    return this.#call('GET', `/v1/charges/${enc(id)}`);
  }
  /** Which invoice a payment intent paid (Charge.invoice and PaymentIntent.invoice no longer exist in the pinned API version). */
  findInvoicePayment(paymentIntentId: string) {
    return this.#call<{ data: StripeObject[] }>('GET', '/v1/invoice_payments', { payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 });
  }
}

const enc = encodeURIComponent;
