export const STRIPE_FAKE_API_VERSION: '2025-09-30.clover';

export type CardKind = 'ok' | 'decline' | 'requires_action';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StripeObject = Record<string, any>;

export interface FakeStripeOptions {
  webhookSecret?: string;
  now?: () => number;
  publicBase?: string;
  autoDeliver?: boolean;
}

export interface StartFakeStripeOptions extends FakeStripeOptions {
  port?: number;
  host?: string;
  webhookUrl?: string;
}

export interface FakeStripeCall {
  method: string;
  path: string;
  query: StripeObject;
  form: StripeObject;
  headers: { idempotencyKey: string | null; stripeVersion: string | null; hasAuth: boolean };
}

export interface FakeStripeEvent {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  api_version: string;
  data: { object: StripeObject };
  [k: string]: unknown;
}

export interface FakeStripeDelivery { eventId: string; type: string; status: number }

export type WebhookTarget = ((request: Request) => Promise<Response>) | string;

export interface FakeStripe {
  state: {
    customers: Map<string, StripeObject>;
    sessions: Map<string, StripeObject>;
    setupIntents: Map<string, StripeObject>;
    paymentMethods: Map<string, StripeObject>;
    invoices: Map<string, StripeObject>;
    invoiceItems: Map<string, StripeObject>;
    paymentIntents: Map<string, StripeObject>;
    charges: Map<string, StripeObject>;
    refunds: Map<string, StripeObject>;
    portalSessions: Map<string, StripeObject>;
    prices: Map<string, StripeObject>;
    events: Map<string, FakeStripeEvent>;
  };
  calls: FakeStripeCall[];
  /** Key prefixes only, e.g. 'rk_test_'. */
  keySeen: string[];
  deliveries: FakeStripeDelivery[];
  livemode: boolean;
  webhookSecret: string;
  publicBase: string;
  autoDeliver: boolean;

  handle(request: Request): Promise<Response>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  seedPrice(partial: StripeObject): StripeObject;
  setNextCard(kind: CardKind): void;
  /** Returns the URL the browser would be sent to. */
  completeCheckout(sessionId: string, opts?: { card?: CardKind | 'cancel' }): string;
  completeInvoiceAction(invoiceId: string, action: 'succeed' | 'fail'): StripeObject;
  /** Returns the refund object; the charge in `state.charges` is updated. */
  refund(chargeId: string, amountMinor?: number): StripeObject;
  deleteCustomer(id: string): void;
  failNext(matcher: string | RegExp, failure?: { status?: number; error?: StripeObject }): void;
  reset(): void;

  makeEvent(type: string, object: StripeObject, extra?: StripeObject): FakeStripeEvent;
  setWebhookTarget(target: WebhookTarget | null): void;
  deliver(event: FakeStripeEvent): Promise<Response>;
  flush(): Promise<FakeStripeDelivery[]>;
  redeliver(eventId: string): Promise<Response>;
}

export function createFakeStripe(opts?: FakeStripeOptions): FakeStripe;
/** Async because it uses crypto.subtle. Returns `t=<seconds>,v1=<hex>`. */
export function signStripePayload(secret: string, body: string, tSeconds?: number): Promise<string>;
export function parseStripeForm(text: string): StripeObject;

export function startFakeStripe(opts?: StartFakeStripeOptions): Promise<{
  url: string;
  port: number;
  fake: FakeStripe;
  close(): Promise<void>;
}>;
