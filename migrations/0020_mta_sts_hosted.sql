-- MTA-STS on the hosted service (ADR 0026). Additive only: every column is nullable or has a default that keeps today's rows working.
--
-- mta_sts_config
--   via                   how the three records got (or will get) into the customer's DNS: 'cloudflare' (written through the workspace's
--                         connection) or 'manual' (the person adds them). NULL on rows made before this migration = 'cloudflare'.
--   state                 where the setup stands: waiting_records, waiting_certificate, waiting_txt, active. Rows made before this migration are 'active'.
--   policy_host           how mta-sts.<domain> reaches this Worker: 'worker_route' (a proxied CNAME to the Worker host or the operator's target; the
--                         self-host way and the operator's own domain) or 'saas_hostname' (a DNS-only CNAME to the operator's target plus a
--                         Cloudflare for SaaS custom hostname and a Worker route in the operator's zone). Old rows are 'worker_route'.
--   ch_id, ch_status, ch_ssl_status   the custom hostname (saas_hostname): its id at Cloudflare and the status and certificate status last read.
--   route_id              the Worker route created in the operator's zone (saas_hostname, and worker_route on the operator's own domain).
--   policy_published_at   when the current policy id was last put in DNS (or shown to be put there). NULL = not published yet.
--   mode_changed_at       when the mode last changed (enable counts). left_enforce_at: when it last went from enforce back to testing.
--   last_checked_at       when the daily job last looked at this row (oldest first, bounded per run).
--   notice, notice_at     one state notice for the person (MX list changed, switched back to testing...), dismissed by an owner or admin.
--   fetch_checked_at, fetch_ok, fetch_reason   the last FETCH of https://mta-sts.<domain>/.well-known/mta-sts.txt by the reconcile (status 200, text/plain, the exact
--                         policy text, over a valid certificate): when, whether it passed (1/0, NULL = never fetched) and one reason code. The page's "served" comes only from here.
-- mta_sts_retiring      a policy being taken down the RFC 8461 section 8.3 way (a lost proof, a removed or an evicted domain): it serves mode none (one day) until
--                         retire_after (the last served policy's max_age after the change; a week after an enforce policy), then its custom hostname and records go.
--                         Not a reference to domains: a removed domain is gone and an evicted one renamed, while senders may still hold the policy. Serving it needs
--                         no proof of the domain.
-- tls_reports
--   sts_success, sts_failure, sts_failure_types   the sessions of policies of type "sts" only (a report also counts tlsa and no-policy-found sessions
--                         in the existing totals), and the distinct failure result-types of those policies as a JSON array. NULL on old rows = unknown.
--   reporter_auth, reporter_tier, reporter_identity   who sent the report mail, decided by the one rule DMARC reports use (src/dmarc/reporter-auth.ts): the
--                         authentication result (pass | fail | none), the tier (counted | unknown | unauthenticated) and the identity (registry id, authenticated
--                         organisation, or ~unauth). Only 'counted' reports are evidence for enforce (RFC 8460 section 3). NULL on old rows = not counted.
--   report_id             the reporter's own report-id, or ~period|<start>|<end>|<policy-domain> when it sent none. Unique per (domain, reporter_identity): a replay
--                         changes nothing and a stranger cannot squat a real reporter's id.
ALTER TABLE mta_sts_config ADD COLUMN via TEXT;
ALTER TABLE mta_sts_config ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE mta_sts_config ADD COLUMN policy_host TEXT NOT NULL DEFAULT 'worker_route';
ALTER TABLE mta_sts_config ADD COLUMN ch_id TEXT;
ALTER TABLE mta_sts_config ADD COLUMN ch_status TEXT;
ALTER TABLE mta_sts_config ADD COLUMN ch_ssl_status TEXT;
ALTER TABLE mta_sts_config ADD COLUMN route_id TEXT;
ALTER TABLE mta_sts_config ADD COLUMN policy_published_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN mode_changed_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN left_enforce_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN last_checked_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN notice TEXT;
ALTER TABLE mta_sts_config ADD COLUMN notice_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN fetch_checked_at INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN fetch_ok INTEGER;
ALTER TABLE mta_sts_config ADD COLUMN fetch_reason TEXT;
UPDATE mta_sts_config SET policy_published_at = updated_at, mode_changed_at = updated_at WHERE policy_published_at IS NULL;
CREATE INDEX idx_mta_sts_checked ON mta_sts_config (enabled, last_checked_at);

ALTER TABLE tls_reports ADD COLUMN sts_success INTEGER;
ALTER TABLE tls_reports ADD COLUMN sts_failure INTEGER;
ALTER TABLE tls_reports ADD COLUMN sts_failure_types TEXT;
ALTER TABLE tls_reports ADD COLUMN reporter_auth TEXT;
ALTER TABLE tls_reports ADD COLUMN reporter_tier TEXT;
ALTER TABLE tls_reports ADD COLUMN reporter_identity TEXT;
ALTER TABLE tls_reports ADD COLUMN report_id TEXT;
CREATE UNIQUE INDEX idx_tls_reports_dedup ON tls_reports (domain_id, reporter_identity, report_id) WHERE report_id IS NOT NULL;

CREATE TABLE mta_sts_retiring (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode_before TEXT NOT NULL,
  mx_hosts TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  via TEXT,
  policy_host TEXT NOT NULL DEFAULT 'worker_route',
  ch_id TEXT,
  mta_sts_record_id TEXT,
  tls_rpt_record_id TEXT,
  cname_record_id TEXT,
  cf_connection_id TEXT,
  retire_after INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, domain)
);
CREATE INDEX idx_mta_sts_retiring_after ON mta_sts_retiring (retire_after);
CREATE INDEX idx_mta_sts_retiring_domain ON mta_sts_retiring (domain);
