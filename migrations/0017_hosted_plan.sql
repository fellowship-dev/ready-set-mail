-- Hosted plan: free for one domain, pay as you go for more (docs/billing.md, docs/adr/0014). Additive only.
-- Nothing here changes behaviour until the hosted service sets HOSTED_PLAN=free_one_domain.
--
-- workspaces.plan                free | payg. payg: a Stripe subscription exists for this workspace (workspace_subscriptions).
-- workspaces.free_owner_user_id  non-NULL: this workspace holds that person's one free domain (the allowance). The unique index makes a second
--                        free workspace for one person impossible under any race. NULL: the workspace holds no allowance.
-- workspaces.plan_lock_*         the per-workspace lease every plan change runs under (src/hosted/plan.ts withPlanLock); plan_revision is bumped
--                        inside each locked change and is part of the Stripe idempotency keys.
-- workspace_subscriptions        the one Stripe subscription of a pay-as-you-go workspace: the status, quantity and period as last seen. No card data.
--                        quantity_sent is what the server last pushed; dirty = the database count may differ from Stripe's (the daily job repairs it).
-- workspace_intents              a person's wish to create another workspace, held until the card is verified: the workspace id is allocated here and
--                        the workspace row is written only when the setup Checkout succeeded.
-- domains.org_domain             the organizational domain (the unit of the plan: a domain with all its subdomains); NULL = the row's own name.
--                        Written by the Worker (SQL cannot compute the Public Suffix List); rows from before are filled in by ensureOrgDomains.
-- domains.payment_pending_at     set while a paid domain waits for the owner's bank to confirm the first payment (3-D Secure); cleared when Stripe says paid,
--                        the row is removed again if the payment never completes.
-- domains.paused_at              set when the plan lapsed (or the owner kept one domain): readable and exportable, new reports are not processed.
-- billing_price_cache.interval   month | year for a recurring price, NULL for the one-time offer price.
-- aggregate_reports.summarised_* / report_records.summarised_sources  a report too large to store row by row keeps every passing row and the biggest
--                        failing rows; the rest are folded into one row per source network with exact message totals (src/dmarc/summarise.ts).
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'payg'));
ALTER TABLE workspaces ADD COLUMN free_owner_user_id TEXT;
ALTER TABLE workspaces ADD COLUMN plan_lock_token TEXT;
ALTER TABLE workspaces ADD COLUMN plan_lock_until INTEGER;
ALTER TABLE workspaces ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_workspaces_free_owner ON workspaces (free_owner_user_id) WHERE free_owner_user_id IS NOT NULL;

-- Backfill: each owner's allowance goes to their OLDEST owned workspace (workspace creation time, then id: deterministic). A workspace with
-- several owners holds the allowance of the earliest-joined owner for whom it is the oldest; the other owners' allowance is then free to be claimed.
UPDATE workspaces SET free_owner_user_id = (
  SELECT m.user_id FROM memberships m
  WHERE m.workspace_id = workspaces.id AND m.role = 'owner'
    AND workspaces.id = (SELECT m2.workspace_id FROM memberships m2 JOIN workspaces w2 ON w2.id = m2.workspace_id
                         WHERE m2.user_id = m.user_id AND m2.role = 'owner' ORDER BY w2.created_at, w2.id LIMIT 1)
  ORDER BY m.created_at, m.user_id LIMIT 1);

CREATE TABLE workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL,
  stripe_item_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  status TEXT NOT NULL,
  quantity_sent INTEGER NOT NULL DEFAULT 0,
  quantity_seen INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at INTEGER,
  lapsed_at INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  action_url TEXT,
  last_failed_at INTEGER,
  synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX idx_workspace_subscriptions_stripe ON workspace_subscriptions (stripe_subscription_id);
CREATE INDEX idx_workspace_subscriptions_sync ON workspace_subscriptions (synced_at);

CREATE TABLE workspace_intents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  stripe_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'created', 'expired')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX idx_workspace_intents_user ON workspace_intents (user_id, status);

ALTER TABLE domains ADD COLUMN org_domain TEXT;
ALTER TABLE domains ADD COLUMN paused_at INTEGER;
ALTER TABLE domains ADD COLUMN payment_pending_at INTEGER;
CREATE INDEX idx_domains_workspace_org ON domains (workspace_id, org_domain);

ALTER TABLE billing_price_cache ADD COLUMN interval TEXT;

ALTER TABLE aggregate_reports ADD COLUMN summarised_rows INTEGER;
ALTER TABLE aggregate_reports ADD COLUMN summarised_sources INTEGER;
ALTER TABLE report_records ADD COLUMN summarised_sources INTEGER;
