-- Lifecycle emails for hosted account holders (src/lifecycle/email/). Additive only; nothing is sent unless MODE=saas.
--
-- domain_milestones   one row per domain: when its DMARC record was first seen naming the domain's reports address (records_live_at) and who
--                     saw it first (live_seen_by): 'app' (a person was on the dashboard, so no email) or 'job' (the daily job, which then
--                     sends "records live"). Written from the same call sites as the analytics event, whether or not PostHog is on.
-- email_preferences   a person's choice, per workspace, for the 'summary' and 'tips' emails. No row: the default for their role.
-- lifecycle_sends     every lifecycle email, claimed (INSERT OR IGNORE) before it is sent, so a second run cannot send it twice. domain_id 0: not
--                     about one domain. state: claimed (being sent), sent, failed (outcome unknown, never retried). A claim that sent nothing
--                     for a retryable reason is deleted again.
CREATE TABLE domain_milestones (
  domain_id INTEGER PRIMARY KEY NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  records_live_at INTEGER,
  live_seen_by TEXT,
  CONSTRAINT domain_milestones_seen_by_check CHECK (live_seen_by IN ('app', 'job'))
);
CREATE INDEX idx_domain_milestones_workspace ON domain_milestones (workspace_id);

CREATE TABLE email_preferences (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, workspace_id, kind),
  CONSTRAINT email_preferences_kind_check CHECK (kind IN ('summary', 'tips'))
);
CREATE INDEX idx_email_preferences_workspace ON email_preferences (workspace_id);

CREATE TABLE lifecycle_sends (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  domain_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, user_id, domain_id, kind, period),
  CONSTRAINT lifecycle_sends_state_check CHECK (state IN ('claimed', 'sent', 'failed'))
);
CREATE INDEX idx_lifecycle_sends_user ON lifecycle_sends (user_id, created_at);
