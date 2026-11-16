import type { ReportVisibilityFields } from './uncounted';
export interface ParentContext {
  domain: string;
  dmarc_policy: string | null;
  dmarc_sp: string | null;    // effective sp= (null if no DMARC)
  has_dmarc: boolean;
}

export interface Domain {
  id: number;
  domain: string;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  rua_address: string;
  parent_id: number | null;   // non-null for subdomains
  created_at: number; // unix timestamp
  alerts_enabled: number; // 1 = on, 0 = off
  is_default: number; // 1 = this domain is the reports infrastructure hub
  /** The Cloudflare account its zone belongs to, when it was verified through one. */
  cf_account_id?: string | null;
  /** How it was proven; 'legacy' is unproven. `proof_lost_at` is set when a proof that was made lapsed (unix seconds). */
  verified_via?: string;
  proof_lost_at?: number | null;
}

export interface DailyStat {
  day: string;
  total: number;
  passed: number;
  failed: number;
}

export interface DomainStats extends ReportVisibilityFields {
  domain: string;
  days: number;
  stats: DailyStat[];
}

/** A domain someone asked to monitor but has not proven they own (SaaS). `lost`: another workspace verified it first. */
export interface DomainClaim {
  id: number | string;
  domain: string;
  status: 'pending' | 'lost';
  txt_name: string;
  txt_value: string;
  created_at: number;
  last_checked_at: number | null;
  last_error: string | null;
}

/** POST /api/domains answers 202 with this when ownership still has to be proven. */
export interface PendingDomainResult {
  pending: true;
  claim: DomainClaim;
  domain: null;
}

export interface AddDomainResult {
  domain: Domain;
  rua_hint: string;
  manual_dns?: boolean;
  dns_instructions?: string;
  parent_context?: ParentContext;
  /** The workspace already had the domain (a repeat verify or add): nothing new was verified. */
  resumed?: boolean;
}

export interface FailingSource {
  source_ip: string;
  total: number;
  header_from: string | null;
  base_domain: string | null;
  org: string | null;
}

export interface ReportSource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  count: number;
  spf_pass: number;
  dkim_pass: number;
  disposition: string;
  reporters: string;
  base_domain: string | null;
  org: string | null;
}

export interface AnomalySource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  total: number;
  spf_pass: number;
  dkim_pass: number;
  first_seen: string; // YYYY-MM-DD
  last_seen: string;  // YYYY-MM-DD
  base_domain: string | null;
  org: string | null;
}

export interface CheckResult {
  id: number;
  from_email: string;
  from_domain: string;
  spf_result: string | null;
  spf_domain: string | null;
  spf_record: string | null;
  dkim_result: string | null;
  dkim_domain: string | null;
  dmarc_result: string | null;
  dmarc_policy: string | null;
  dmarc_record: string | null;
  overall_status: 'protected' | 'at_risk' | 'exposed';
  session_token: string | null;
  spf_lookup_count: number | null;
  created_at: number;
}

export interface AggregateReport {
  id: number;
  domain: string;
  org_name: string;
  report_id: string;
  date_begin: number; // unix timestamp
  date_end: number;   // unix timestamp
  total_count: number;
  pass_count: number;
  fail_count: number;
  /** Did the report email itself pass DMARC-aligned auth? null = reported before this was recorded. */
  reporter_auth?: 'pass' | 'fail' | 'none' | null;
  reporter_auth_domain?: string | null;
  /** Why the sender was not authenticated (a reason code), or null. */
  reporter_auth_reason?: string | null;
  /** What the intake decided: counted (authenticated and known), unknown (authenticated, not known), unauthenticated. Null: stored before senders were checked. */
  reporter_tier?: 'counted' | 'unknown' | 'unauthenticated' | null;
  /** The known-reporters organisation that matched. */
  reporter_known_as?: string | null;
  /** Does this report feed the numbers (REPORT_COUNTING)? Absent on older servers. */
  counted?: boolean;
}

export interface SpfFlatConfig {
  enabled: number;                 // 0 | 1
  cf_record_id: string | null;
  canonical_record: string;
  flattened_record: string | null;
  ip_count: number | null;
  lookup_count: number | null;
  last_flattened_at: number | null;
  last_error: string | null;
}

export interface SpfFlatStatus {
  available: boolean;
  config: SpfFlatConfig | null;
  lookup_count: number | null;  // from domains.spf_lookup_count — populated on add + daily cron
}

/** GET /api/domains/:id/mta-sts (docs/mta-sts.md). */
export type MtaStsUnavailable = 'hosted_records' | 'unproven' | 'not_configured' | 'not_allowed' | 'ceiling' | 'zone_subdomain' | 'needs_cloudflare' | 'reports_domain_missing';
export type MtaStsState = 'creating' | 'waiting_records' | 'waiting_certificate' | 'waiting_policy' | 'waiting_txt' | 'active';
export type MtaStsVia = 'cloudflare' | 'manual';

export interface MtaStsRecord {
  purpose: 'policy_host' | 'tls_rpt' | 'policy_id';
  type: 'CNAME' | 'TXT';
  name: string;
  /** null: the value cannot be told (self-host: the Worker's host could not be read). */
  value: string | null;
  proxied?: boolean;
  /** Ready Set Mail wrote it through the Cloudflare connection. */
  written: boolean;
  /** By hand: the person should add it now. */
  add_now: boolean;
  note?: string;
}

export interface MtaStsConfig {
  enabled: number;
  mode: 'testing' | 'enforce';
  state: MtaStsState;
  via: MtaStsVia;
  policy_host: 'worker_route' | 'saas_hostname';
  mx_hosts: string; // comma-separated
  mx_host_list: string[];
  policy_id: string;
  max_age: number;
  policy_published_at: number | null;
  mode_changed_at: number | null;
  left_enforce_at: number | null;
  last_checked_at: number | null;
  last_error: string | null;
  notice: string | null;
  notice_at: number | null;
  created_at: number;
  updated_at: number;
  domain_id: number;
}

export interface MtaStsReport {
  id: number;
  reporter: string;
  period_start: number;
  period_end: number;
  received_at: number;
  successful_sessions: number;
  failed_sessions: number;
  /** null on reports stored before the MTA-STS sessions were kept apart. */
  sts_successful_sessions: number | null;
  sts_failed_sessions: number | null;
  failure_types: string[];
  /** Only a counted report (authenticated, from a known reporter) is evidence for enforce; `reporter` of an uncounted one is its authenticated organisation or "unverified sender". */
  counted?: boolean;
}

/** The last fetch of the policy URL: the only source of "served". `ok` is null until it was fetched once; `reason` and `message` are set when it failed. */
export interface MtaStsServed { ok: boolean | null; checked_at: number | null; reason: string | null; message: string | null; action: 'check_now' | 'fix_record' | null; url: string }

/** A policy being taken down the RFC 8461 section 8.3 way (a lost proof, a removed or an evicted domain). */
export interface MtaStsRetiring { retiring: true; reason: 'lost_proof' | 'removed' | 'evicted'; enforced: boolean; until: number; message: string }

export interface MtaStsStatus {
  available: boolean;
  unavailable_reason: MtaStsUnavailable | 'none';
  unavailable_message: string | null;
  via: MtaStsVia | null;
  policy_host: 'worker_route' | 'saas_hostname' | null;
  mx_preview: { status: 'ok' | 'none' | 'error'; hosts: string[]; error: string | null };
  records: MtaStsRecord[];
  records_problem: string | null;
  config: MtaStsConfig | null;
  policy_host_status: { kind: 'worker_route' | 'saas_hostname'; hostname: string; route: boolean; certificate: { status: string | null; ssl_status: string | null; active: boolean } | null } | null;
  summary: { total_success: number; total_failure: number; report_count: number; sts_success: number; sts_failure: number } | null;
  reports: MtaStsReport[];
  enforce: { ready: boolean; allowed: boolean; reasons: string[] } | null;
  /** The evidence rule in one sentence, the sentence about domains without reports, and how many reports in the last 30 days are evidence or not; `verifiable` false: this server cannot tell who sent a report. */
  evidence?: { rule: string; no_reports_note: string; counted_reports: number; uncounted_reports: number; verifiable: boolean } | null;
  disable: { allowed: boolean; after: number | null; reason: string | null } | null;
  max_age: number;
  served?: MtaStsServed | null;
  /** The one notice of a setup that was stopped after 7 days. */
  setup_expired?: { notice: string; at: number | null } | null;
  retiring?: MtaStsRetiring | null;
}

export type MtaStsCheckState = 'ok' | 'pending' | 'missing' | 'wrong' | 'error' | 'not_applicable';
export interface MtaStsCheck {
  key: 'policy_host' | 'certificate' | 'policy_fetch' | 'tls_rpt' | 'policy_id';
  label: string;
  state: MtaStsCheckState;
  detail: string | null;
}
export interface MtaStsVerifyResult { ok: boolean; state: MtaStsState; checks: MtaStsCheck[]; served: MtaStsServed; notice: string | null; last_error: string | null }
export interface MtaStsDisableResult { ok: boolean; kept: Array<{ type: string; name: string; reason: string }>; operator: 'none' | 'removed' | 'pending'; message: string }

export interface AuditLogEntry {
  id: number;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: 'user' | 'system';
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  before_value: string | null;  // JSON string
  after_value: string | null;   // JSON string
  meta: string | null;          // JSON string
  created_at: number;           // unix timestamp
}

export interface DayReport {
  date: string;
  domain: string;
  summary: { total: number; passed: number; failed: number };
  sources: ReportSource[];
}


export interface OnboardingStatus {
  domain_id: number;
  domain: string;
  rua_address: string;
  cf_available: boolean;
  dmarc: {
    found: boolean;
    has_our_rua: boolean;
    current_record: string | null;
    // No rua_address here: the API sends it once, at the top level, and it is empty without a reports domain.
    auth_record?: {
      found: boolean;
      record_name: string | null;
    };
    /**
     * The policy that applies (RFC 7489): the domain's own record, else its organizational domain's (`inherited_from`).
     * Null when DNS could not say; absent from older servers. Never offer a record weaker than this policy.
     */
    effective?: { policy: string | null; inherited_from: string | null; issue: string | null; /** The inherited record's text (its pct= matters), null when not inherited. */ record?: string | null } | null;
  };
  /** DNS said the name itself does not exist (NXDOMAIN). */
  nxdomain?: boolean;
  spf: {
    record: string | null;
    lookup_count: number | null;
    flattening_active: boolean;
  };
  dkim: {
    selectors: { name: string; record: string }[];
    source: 'cf' | 'doh';
    /** Every name under _domainkey answers with the same TXT record: `selectors` is empty because public DNS cannot say which exist. */
    wildcard?: boolean;
    wildcard_record?: string;
  };
  routing: {
    mx_found: boolean;
    destination_verified: boolean;
    destination_debug?: string;
    reports_domain: string | null;
    admin_email: string | null;
    null_sender_spf?: boolean;
    null_sender_dmarc?: boolean;
  };
  /** Checks whose DNS lookup failed ("spf: …", "dmarc: …", "mx: …", "dkim <selector>: …"). Their values are unknown, not absent. */
  dns_errors?: string[];
}

export interface DomainCheckSummary extends ReportVisibilityFields {
  /**
   * Hosted report intake, per domain (GET /api/domains/summaries): whether reports can be connected, and the server's
   * reason and its kind when not. Null on a self-hosted instance; absent from /check-summary.
   */
  report_connect?: { can_connect: boolean; refusal: string | null; refusal_kind: 'unavailable' | 'hosted_records' | 'ownership' | 'operator_only' | null } | null;
  domain_id: number;
  domain: string;
  dmarc_policy: string | null;
  spf_record: string | null;
  /** Unix seconds both records were last read from DNS; null: never. */
  dns_checked_at: number | null;
  /** Unix seconds of the last attempt, and its result: 'ok' | 'failed' | 'nxdomain'. Null: never attempted. */
  dns_check_attempted_at: number | null;
  dns_check_status: string | null;
  /** Why DMARC gave no usable policy: 'multiple' | 'invalid' (no valid p=) | 'invalid_sp' (an invalid sp=). */
  dmarc_issue: string | null;
  /** The organizational domain dmarc_policy was inherited from (the domain has no record of its own). */
  dmarc_inherited_from: string | null;
  /** Status of the last check that read both records: 'ok' | 'nxdomain'. Unlike dns_check_status it survives a failed attempt. */
  dns_last_good_status: string | null;
  total_messages: number;
  pass_messages: number;
  fail_messages: number;
  dkim_total: number;
  dkim_pass: number;
  spf_total: number;
  spf_pass: number;
  mta_sts_enabled: number; // 0 | 1
  mta_sts_mode: string | null;
  /** SPF DNS lookups at the last refresh; null: not counted. */
  spf_lookup_count?: number | null;
  /**
   * The governing DMARC record (own, else the organizational domain's) at the last read (0012): pct=, p=, sp= as written
   * (null: no sp= tag) and whether its rua= names this domain's reports address (1/0). dmarc_p null or absent with a
   * policy: not read since 0012. See packages/dns-checks/src/dmarc-next-step.ts.
   */
  dmarc_pct?: number | null;
  dmarc_p?: string | null;
  dmarc_sp?: string | null;
  dmarc_rua?: number | null;
}

export type WizardStepState = 'not_started' | 'complete' | 'skipped';

export interface WizardState {
  domain: WizardStepState;
  spf: WizardStepState;
  dkim: WizardStepState;
  dmarc: WizardStepState;
  routing: WizardStepState;
}

export type Role = 'owner' | 'admin' | 'member';

/** GET /api/me */
export interface Me {
  user: { id: string; email: string; name: string } | null;
  /** Null (with `workspace_id` null) for a verified login that belongs to no workspace yet. */
  role: Role | null;
  workspace_id: string | null;
  kind: 'instance' | 'api_key' | 'session';
  /** Set (with `workspace_id: null`) for a verified login that belongs to no workspace yet: the invitations waiting for its email. */
  pending_invites?: Array<{ token: string; role: string; invited_by: string; workspace_id: string; workspace_name: string | null }>;
  /** Runs this instance (OWNER_EMAIL, or the self-host owner): sees the leads page. */
  instance_owner?: boolean;
  /** Hosted: what the person said on sign-up about whose email they set up (never the free-text answers). */
  whose_email?: 'company' | 'clients' | 'looking';
  /** Hosted, "My clients'": the agency's own name. The workspace switcher's heading; each client workspace is a row under it. */
  agency_name?: string;
}

/** GET /api/leads (instance owner only) */
export interface LeadRow {
  id: number;
  email: string;
  domain: string;
  source: string;
  level: 'protected' | 'at_risk' | 'exposed' | null;
  step: number;
  steps_total: number;
  status: 'active' | 'completed' | 'unsubscribed' | 'bounced' | 'replied' | 'booked' | 'converted';
  next_send_at: number | null;
  last_sent_at: number | null;
  created_at: number;
  last_activity_at: number;
}

export interface LeadsResponse {
  leads: LeadRow[];
  counts: Record<string, number>;
  delivery: { enabled: boolean; can_send: boolean; provider: string | null; blockers: string[]; warnings: string[] };
}

/** GET /api/auth/status (public) */
export interface AuthStatus {
  configured: boolean;
  mode: 'self-host' | 'saas';
  /** Self-host only, present when HOSTED_SERVICE_URL is set: the hosted free tier's https URL. */
  hosted_service_url?: string;
  signup_open: boolean;
  /** False when the instance cannot sign anybody in (hosted without bot protection); `signup_unavailable_reason` says why, for sign-up and sign-in alike. */
  signin_available: boolean;
  signup_unavailable_reason?: 'bot_protection_not_configured';
  oauth_providers: string[];
  prefill: { name: string; email: string };
  /** Hosted with PostHog configured: the dashboard counts a few steps (docs/analytics.md). */
  product_analytics?: boolean;
  turnstile_site_key: string | null;
  custom_domain: string | null;
  base_domain: string | null;
  has_domain: boolean;
  /** Hosted only: the https booking link behind "Talk to Max". Null (or absent) = show no link anywhere. */
  help_url?: string | null;
  /** False when the free email check cannot work here (hosted without a canary domain): its menu item is hidden. */
  email_check?: boolean;
  /** Whether sign-in ends with an emailed 6-digit code, and why. */
  signin_codes?: boolean;
  signin_codes_reason?: 'hosted' | 'mail' | 'no_mail' | 'turned_off';
  /** Self-host with codes on: the domain the code email is sent from (e.g. reports.example.com). */
  signin_code_sender_domain?: string | null;
}

/** GET /api/keys: prefixes only, never the secret. */
export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

/** GET /api/agents/status: can agents connect to this instance, and at which MCP server URL. */
export interface AgentStatus {
  available: boolean;
  server_url: string | null;
}

/** GET /api/instance/preflight (instance owner only): configuration problems by setting name, never a value. */
export interface PreflightItem {
  id: 'mode' | 'auth_url' | 'oauth_storage' | 'booking_link' | 'mail_sender' | 'bot_check' | 'client_registration' | 'rate_limits' | 'public_reports';
  severity: 'action' | 'note';
  setting: string;
  message: string;
}
export interface Preflight {
  mode: 'self-host' | 'saas';
  agents: AgentStatus;
  items: PreflightItem[];
  /** Present when public reports are on or any are stored: their storage against PUBLIC_REPORTS_TOTAL_BYTES. */
  public_reports?: { enabled: boolean; stored_reports: number; stored_bytes: number; total_budget_bytes: number; used_percent: number; near_limit: boolean };
}
