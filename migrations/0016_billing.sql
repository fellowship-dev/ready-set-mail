-- In-app billing for the hosted service (Stripe: one customer per workspace, a one-time "Fix one domain" order). Additive only.
-- Nothing here is used unless the hosted service has STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET set (docs/billing.md).
--
-- workspaces.stripe_customer_id  the workspace's Stripe Customer (one card per workspace), created on first need. Unique: one customer is one workspace.
--                        Cleared when Stripe says the customer was deleted. The customer is never deleted by us.
-- billing_orders         one purchase. Accounting records: NO foreign key to workspaces or domains, so deleting either keeps the row (workspace and
--                        domain names are snapshots). status: pending, paid, started, done, refunded, failed, canceled (src/billing/orders.ts is the
--                        one place that validates moves). amount is in minor units. The partial unique index is "one open order per workspace +
--                        domain name + offer" (open = pending, paid, started): a second confirm loses the insert and gets the first order back.
--                        failed_at is also the time of a cancel. owner_notified_at: when the instance owner was emailed that it was paid.
--                        amount_paid: what Stripe collected (after a customer credit balance or coupon it can be less than amount). operator_alerted_at:
--                        when the instance owner was emailed that this order needs attention (a paid invoice that is not what we sold, or a payment
--                        for an order already closed); at most once per order.
-- billing_events         Stripe events already seen (insert-first, so a repeated delivery does no work twice). status: processing, done, ignored, failed.
-- billing_checkout_sessions  binds a Stripe Checkout (setup) session to the workspace and user that started it, with the validated return path.
--                        ref is our own id, inserted before Stripe is called; stripe_session_id is filled in once Stripe answers.
-- billing_price_cache    the Stripe price the offer resolves to by lookup key (amount and currency come from Stripe, never from code).
ALTER TABLE workspaces ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX idx_workspaces_stripe_customer ON workspaces (stripe_customer_id);

CREATE TABLE billing_orders (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  domain_id INTEGER,
  domain_name TEXT NOT NULL,
  offer TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  amount_paid INTEGER,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_customer_id TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  hosted_invoice_url TEXT,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  buyer_user_id TEXT,
  buyer_email TEXT,
  failure_code TEXT,
  failure_message TEXT,
  note TEXT,
  owner_notified_at INTEGER,
  operator_alerted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  paid_at INTEGER,
  started_at INTEGER,
  done_at INTEGER,
  refunded_at INTEGER,
  failed_at INTEGER
);
CREATE UNIQUE INDEX idx_billing_orders_open ON billing_orders (workspace_id, domain_name, offer) WHERE status IN ('pending', 'paid', 'started');
CREATE UNIQUE INDEX idx_billing_orders_invoice ON billing_orders (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX idx_billing_orders_charge ON billing_orders (stripe_charge_id);
CREATE INDEX idx_billing_orders_workspace ON billing_orders (workspace_id, created_at);
CREATE INDEX idx_billing_orders_status ON billing_orders (status, created_at);

CREATE TABLE billing_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  attempts INTEGER NOT NULL DEFAULT 1,
  outcome TEXT,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_billing_events_received ON billing_events (received_at);

CREATE TABLE billing_checkout_sessions (
  ref TEXT PRIMARY KEY NOT NULL,
  stripe_session_id TEXT,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  return_path TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE UNIQUE INDEX idx_billing_checkout_stripe ON billing_checkout_sessions (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX idx_billing_checkout_workspace ON billing_checkout_sessions (workspace_id);

CREATE TABLE billing_price_cache (
  lookup_key TEXT PRIMARY KEY NOT NULL,
  price_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
