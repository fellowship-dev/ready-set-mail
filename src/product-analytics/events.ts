// The hosted dashboard's product events (docs/analytics.md): every event the Worker may send to PostHog, and for each one the
// closed set of properties it may carry and the closed set of values each property may take. This table IS the allow-list:
// capture() (capture.ts) drops any property not named here and any value not listed, before anything leaves the Worker.
//
// Naming (the website's convention, ready-set-mail-website lib/posthog.ts): Title Case `Object Verb`, past tense. Every event also
// carries `surface: 'app'` (the website sends `web`), added by capture(). Values are categories and buckets only: never a name, an
// address, a domain, a DNS record, a token, an id or a count that could be tied to a customer.

/** Bucket labels. Each helper turns a number into one of these, so no raw count or duration is ever sent. */
export const COUNT = ['0', '1', '2-5', '6-20', '21+'] as const;
export const TRIES = ['1', '2', '3+'] as const;
export const RESENDS = ['0', '1', '2+'] as const;
export const ISSUES = ['0', '1', '2', 'unknown'] as const;
/** Code sent → code typed. */
export const CODE_WAIT = ['under_1m', '1_5m', '5_15m', '15_60m', 'over_1h'] as const;
/** Short waits: Apply → seen in public DNS, invite → accepted. */
export const SHORT_WAIT = ['none', 'under_1m', '1_10m', '10_60m', '1_24h', 'over_24h'] as const;
/** Long waits: sign-up → records live, records live → first report, paid → delivered. */
export const LONG_WAIT = ['none', 'under_1h', '1_24h', '24_48h', '48_72h', '3_7d', 'over_7d'] as const;

/**
 * Where a sign-up came from: the website's `src=<page class>` on its sign-up link (ready-set-mail-website), a closed list; any other
 * value is `other`, and no `src` at all is `cold` (a person who typed the address, or a link from anywhere else).
 */
export const SOURCES = ['home', 'checker', 'report', 'agencies', 'pricing', 'errors', 'tools', 'other'] as const;
export const ENTRIES = [...SOURCES, 'cold'] as const;
export type Entry = (typeof ENTRIES)[number];
/** How an account was created or signed in to. */
export const SIGNUP_METHODS = ['email_code', 'oauth_google', 'oauth_github'] as const;
export type SignupMethod = (typeof SIGNUP_METHODS)[number];
/**
 * Which way a domain's setup went: `cloudflare` (connected, proven by its zone, records written by Apply) or `manual` (proven by a TXT
 * record, records added by hand at any DNS host). Each setup event says which, so each path has a funnel it can finish.
 */
export const PATHS = ['cloudflare', 'manual'] as const;
export type SetupPath = (typeof PATHS)[number];
/** What observed the records live: a setup screen's read, the domain page's DNS check, or the daily job. */
export const SEEN_BY = ['setup', 'domain_page', 'daily'] as const;
export const ROLES = ['owner', 'admin', 'member'] as const;
/** DNS hosts the product recognises (src/domains/dns-host.ts DNS_PROVIDERS ids), plus what detection can say otherwise. */
export const DNS_PROVIDERS = ['cloudflare', 'godaddy', 'porkbun', 'namecheap', 'route53', 'google-cloud-dns', 'squarespace', 'digitalocean', 'vercel', 'ns1', 'other', 'mixed', 'unknown'] as const;
/** The agent tools (src/mcp/server.ts). */
export const AGENT_TOOLS = ['whoami', 'list_products', 'list_domains', 'inspect_domain', 'add_domain', 'verify_domain', 'get_email_report', 'query_email_metrics', 'plan_remediation', 'get_source_status'] as const;

const BOOL = 'bool' as const;
type Allowed = readonly string[] | typeof BOOL;

/** Event name → property → allowed values. Adding an event or a value is a change to this table, its test and docs/analytics.md. */
export const EVENTS = {
  // ── Sign-up and sign-in (src/auth/routes.ts) ──
  'Signup Started': { method: SIGNUP_METHODS, entry: ENTRIES, from_checker: BOOL },
  'Signup Code Sent': { send: ['first', 'resend'] },
  'Code Verified': { purpose: ['signup', 'invite'], entry: ENTRIES, from_checker: BOOL, attempts: TRIES, resends: RESENDS, wait: CODE_WAIT, account_created: BOOL },
  'Workspace Created': { source: ['signup', 'added'], method: SIGNUP_METHODS },
  'Signed In': { method: ['code', 'password', 'oauth_google', 'oauth_github'] },
  // Waiting on the sign-up screens of PR 177 (docs/analytics.md, "Waiting on the new sign-up").
  'Signup Profile Saved': { whose_email: ['company', 'clients', 'looking'], role: ['founder', 'developer', 'it', 'marketing', 'agency', 'other', 'none'], heard_about_given: BOOL },
  'Setup Path Chosen': { path: ['cloudflare', 'records', 'dns_manager', 'teammate'], dns_provider: DNS_PROVIDERS },
  // ── Dashboard ──
  'Dashboard First Viewed': { state: ['no_domains', 'proof_pending', 'domains', 'records_live'], role: ROLES },
  'Workspace Active': { role: ROLES, domains: COUNT },
  // ── Teammates ──
  'Invite Sent': { role: ['admin', 'member'] },
  'Invite Accepted': { role: ['admin', 'member'], wait: SHORT_WAIT },
  // ── Domains and ownership ──
  'Domain Added': { path: PATHS, source: ['typed', 'bulk', 'cloudflare_import', 'agent'], needs_proof: BOOL, added: COUNT, domains: COUNT, dns_provider: DNS_PROVIDERS, verdict_issues: ISSUES },
  'Ownership Verified': { path: PATHS, method: ['cloudflare_zone', 'txt', 'parent', 'selfhost'], wait: SHORT_WAIT },
  // ── Cloudflare ──
  'Cloudflare Connect Started': { path: PATHS, method: ['oauth', 'token'] },
  'Cloudflare Connect Returned': { path: PATHS, method: ['oauth', 'token'], result: ['connected', 'denied', 'failed'], zones: COUNT, accounts: COUNT },
  // ── Records ──
  'Apply Clicked': { path: PATHS, step: ['dmarc', 'reports_mailbox', 'dmarc_record'], changes: COUNT },
  'Apply Done': { path: PATHS, step: ['dmarc', 'reports_mailbox', 'dmarc_record'], result: ['applied', 'partial', 'failed', 'nothing_to_do'], changes: COUNT, reports: ['connected', 'refused', 'limit', 'unavailable', 'none'] },
  'Records Live': { path: PATHS, seen_by: SEEN_BY, method: ['cloudflare_zone', 'txt', 'parent', 'selfhost', 'other'], since_signup: LONG_WAIT, since_apply: SHORT_WAIT, domains_live: COUNT },
  'First Report Received': { path: PATHS, since_live: LONG_WAIT },
  'No Report After 3 Days': { domains_waiting: COUNT },
  // ── Free email check from the dashboard ──
  'Email Check Started': {},
  'Email Check Done': { result: ['protected', 'at_risk', 'exposed', 'other'] },
  // ── Agents (src/mcp/) ──
  'Agent Authorized': { actions: COUNT, domains: COUNT, days: ['1', '2-7', '8-30'] },
  'Agent First Call': { tool: AGENT_TOOLS },
  // ── Billing (src/billing/): price as a tier label, never an amount ──
  'Fix Offer Viewed': { offer: ['fix_one_domain'], has_card: BOOL },
  'Card Setup Started': {},
  'Card Setup Completed': {},
  'Fix Order Created': { offer: ['fix_one_domain'], price_tier: ['list'] },
  'Fix Order Paid': { offer: ['fix_one_domain'], price_tier: ['list', 'reduced'] },
  'Fix Order Failed': { offer: ['fix_one_domain'], reason: ['failed', 'canceled'] },
  'Fix Order Refunded': { offer: ['fix_one_domain'] },
  'Fix Order Delivered': { offer: ['fix_one_domain'], since_paid: LONG_WAIT },
} as const satisfies Record<string, Record<string, Allowed>>;

export type EventName = keyof typeof EVENTS;
type ValueOf<A> = A extends readonly (infer V)[] ? V : A extends typeof BOOL ? boolean : never;
/** The properties an event may carry: each optional, each typed by its allowed values. */
export type PropsOf<E extends EventName> = { -readonly [K in keyof (typeof EVENTS)[E]]?: ValueOf<(typeof EVENTS)[E][K]> };

/**
 * The allow-list applied to one event: only named properties with listed values survive, everything else is dropped silently
 * (an analytics event is never worth an error). Unknown event names yield null.
 */
export function allowed(event: string, props: Record<string, unknown>): Record<string, string | boolean> | null {
  const shape = (EVENTS as Record<string, Record<string, Allowed>>)[event];
  if (!shape) return null;
  const out: Record<string, string | boolean> = {};
  for (const [key, rule] of Object.entries(shape)) {
    const v = props[key];
    if (rule === BOOL) { if (typeof v === 'boolean') out[key] = v; }
    else if (typeof v === 'string' && rule.includes(v)) out[key] = v;
  }
  return out;
}

// ── Buckets ──────────────────────────────────────────────────

export const countBucket = (n: number): (typeof COUNT)[number] => (n <= 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : '21+');
export const triesBucket = (n: number): (typeof TRIES)[number] => (n <= 1 ? '1' : n === 2 ? '2' : '3+');
export const resendsBucket = (n: number): (typeof RESENDS)[number] => (n <= 0 ? '0' : n === 1 ? '1' : '2+');
export const issuesBucket = (n: number | null): (typeof ISSUES)[number] => (n === null ? 'unknown' : n <= 0 ? '0' : n === 1 ? '1' : '2');

export function codeWait(seconds: number): (typeof CODE_WAIT)[number] {
  return seconds < 60 ? 'under_1m' : seconds < 300 ? '1_5m' : seconds < 900 ? '5_15m' : seconds < 3600 ? '15_60m' : 'over_1h';
}
export function shortWait(seconds: number | null): (typeof SHORT_WAIT)[number] {
  if (seconds === null || seconds < 0) return 'none';
  return seconds < 60 ? 'under_1m' : seconds < 600 ? '1_10m' : seconds < 3600 ? '10_60m' : seconds < 86400 ? '1_24h' : 'over_24h';
}
export function longWait(seconds: number | null): (typeof LONG_WAIT)[number] {
  if (seconds === null || seconds < 0) return 'none';
  const h = seconds / 3600;
  return h < 1 ? 'under_1h' : h < 24 ? '1_24h' : h < 48 ? '24_48h' : h < 72 ? '48_72h' : h < 168 ? '3_7d' : 'over_7d';
}
export const daysBucket = (days: number): '1' | '2-7' | '8-30' => (days <= 1 ? '1' : days <= 7 ? '2-7' : '8-30');
