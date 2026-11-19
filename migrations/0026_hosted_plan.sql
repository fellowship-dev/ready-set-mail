-- Hosted plan (pay as you go for extra domains): one row per workspace that has chosen an interval or has a subscription.
-- Additive: nothing existing changes. Used only when HOSTED_PLAN=pay_as_you_go on the hosted service (docs/billing.md).
CREATE TABLE workspace_plans (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  interval TEXT NOT NULL DEFAULT 'year' CHECK (interval IN ('month','year')),
  stripe_subscription_id TEXT,
  stripe_item_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  sync_error TEXT
);
