// One configuration check for the person who runs this instance. On the hosted service (MODE=saas) that person is the
// verified account whose email is OWNER_EMAIL: without OWNER_EMAIL nobody can see this check (src/funnel/routes.ts isInstanceOwner). Workers have no startup hook, so the dashboard
// asks for it (GET /api/instance/preflight, instance owner only). Every message names a setting and what it breaks;
// none ever contains a configured value, so a secret cannot leak through it.
import { forImplicitWorkspace, publicReportQueries } from '@ready-set-mail/db';
import { storageBudget, type PublicReportEnv } from '../public-reports/limits';
import type { BoundEnv } from '../index';
import { mcpInstallation } from '../mcp/discovery';
import { hasEncryptionKey } from '../connections/crypto';
import { getMode } from '../tenancy/mode';
import { bookingUrl, helpUrl, sequenceEnabled } from '../funnel/config';
import { intakeSetupFindings } from '../reports/auth-status';
import { reportIntakePreflightItems } from '../hosted/report-intake-check';
import { billingPreflight } from '../billing/preflight';
import { analyticsState } from '../product-analytics/capture';

export interface PreflightItem {
  /** Stable id for tests and the UI key. */
  id: 'mode' | 'auth_url' | 'oauth_storage' | 'booking_link' | 'mail_sender' | 'bot_check' | 'client_registration' | 'rate_limits' | 'intake' | 'cloudflare_connections' | 'public_reports' | 'billing' | 'product_analytics';
  /** `action`: something does not work until it is fixed. `note`: works, but worth knowing. */
  severity: 'action' | 'note';
  /** The setting(s) to change, by name. */
  setting: string;
  message: string;
}

export interface Preflight {
  mode: 'self-host' | 'saas';
  agents: AgentAvailability;
  items: PreflightItem[];
  /** Public reports' storage, present when creating them is on or any are stored (src/public-reports/limits.ts). */
  public_reports?: PublicReportStorage;
  /** Hosted billing: not configured (off), misconfigured with the reason, or configured (and whether the price resolves). Never a value. Present on the hosted service, or where a STRIPE_* setting exists. */
  billing?: BillingPreflight;
}

export interface BillingPreflight {
  state: 'off' | 'configured' | 'misconfigured';
  reason?: string;
  livemode?: boolean;
  price?: 'ok' | 'misconfigured' | 'unreachable';
}

export interface PublicReportStorage {
  enabled: boolean;
  stored_reports: number;
  stored_bytes: number;
  /** PUBLIC_REPORTS_TOTAL_BYTES as in effect. */
  total_budget_bytes: number;
  /** Whole percent of the total budget in use. */
  used_percent: number;
  /** True from 80% of the total budget; at 100% no new report is made. */
  near_limit: boolean;
}

/** Public reports' storage against PUBLIC_REPORTS_TOTAL_BYTES; null when reports are off and none are stored. */
export async function publicReportStorage(env: BoundEnv & PublicReportEnv): Promise<PublicReportStorage | null> {
  const enabled = env.PUBLIC_REPORTS_ENABLED === '1';
  const usage = await publicReportQueries(env.DB).usage();
  if (!enabled && !usage?.total_reports) return null;
  const budget = storageBudget(env);
  const stored = usage?.total_bytes ?? 0;
  return {
    enabled,
    stored_reports: usage?.total_reports ?? 0,
    stored_bytes: stored,
    total_budget_bytes: budget.totalBytes,
    used_percent: Math.floor((stored / budget.totalBytes) * 100),
    near_limit: stored >= budget.warnBytes,
  };
}

export interface AgentAvailability {
  available: boolean;
  /** The MCP server URL agents connect to, when available. */
  server_url: string | null;
}

/** Can this instance accept agent connections? Needs instance-owned OAuth storage and a canonical HTTPS origin. */
export function agentAvailability(env: Pick<BoundEnv, 'OAUTH_KV' | 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>): AgentAvailability {
  if (!env.OAUTH_KV) return { available: false, server_url: null };
  try {
    return { available: true, server_url: mcpInstallation(env).resource };
  } catch {
    return { available: false, server_url: null };
  }
}

export async function instancePreflight(env: BoundEnv, requestOrigin: string): Promise<Preflight> {
  const items: PreflightItem[] = [];
  const mode = getMode(env);
  const hosted = mode === 'saas';
  const rawMode = env.MODE?.trim().toLowerCase();

  // Mode
  if (rawMode && rawMode !== 'saas' && rawMode !== 'selfhost') {
    items.push({ id: 'mode', severity: 'action', setting: 'MODE', message: 'MODE is set to something other than "selfhost" or "saas", so this instance runs as self-hosted. Set it to one of the two, or remove it.' });
  } else if (!hosted && env.SAAS_ENABLED === '1') {
    items.push({ id: 'mode', severity: 'note', setting: 'MODE, SAAS_ENABLED', message: 'SAAS_ENABLED is 1 but MODE is not "saas", so this instance runs as self-hosted. Remove SAAS_ENABLED, or set MODE to "saas" to run the hosted service.' });
  }

  // Canonical address (sign-in links, cookies, agent issuer)
  let origin: string | null = null;
  try {
    origin = mcpInstallation(env).issuer;
  } catch {
    const set = !!(env.BETTER_AUTH_URL || env.PUBLIC_BASE_URL);
    items.push({
      id: 'auth_url', severity: 'action', setting: 'BETTER_AUTH_URL',
      message: set
        ? 'BETTER_AUTH_URL is not a plain HTTPS address (https://host, with no path). Agents cannot connect, and links in email may point to the wrong place.'
        : 'BETTER_AUTH_URL is not set. Set it to this dashboard\'s HTTPS address (https://host, with no path). Until then agents cannot connect.',
    });
  }
  if (origin && origin !== requestOrigin) {
    items.push({ id: 'auth_url', severity: 'note', setting: 'BETTER_AUTH_URL', message: 'You opened the dashboard at a different address than BETTER_AUTH_URL. Agents connect only through the configured address, and sign-in works most reliably there.' });
  }

  // Agent OAuth storage
  if (!env.OAUTH_KV) {
    items.push({ id: 'oauth_storage', severity: 'action', setting: 'OAUTH_KV', message: 'No OAUTH_KV namespace is bound. Create a KV namespace for this instance only and bind it as OAUTH_KV. Until then agents cannot connect.' });
  }
  if (env.MCP_DCR_ENABLED === '1') {
    items.push({ id: 'client_registration', severity: 'note', setting: 'MCP_DCR_ENABLED', message: 'Open client registration is on: any app can register itself before asking you for access. Turn it off unless an agent you use needs it.' });
  }

  // Mail sender: password reset everywhere, and sign-up confirmation on the hosted service.
  const settings = await forImplicitWorkspace(env.DB).settings.getMany(['from_email', 'base_domain']);
  const sender = settings.get('from_email') || settings.get('base_domain');
  if (!env.SEND_EMAIL || !sender) {
    const what = hosted ? 'Sign-up confirmation and password reset emails' : 'Password reset emails';
    items.push({
      id: 'mail_sender', severity: hosted ? 'action' : 'note', setting: !env.SEND_EMAIL ? 'SEND_EMAIL' : 'Sender address',
      message: !env.SEND_EMAIL
        ? `${what} cannot be sent: the SEND_EMAIL binding is missing.`
        : `${what} cannot be sent: there is no sender address yet. The setup wizard sets it when you add the first domain.`,
    });
  }

  // Bot check (Cloudflare Turnstile)
  const secret = !!env.TURNSTILE_SECRET_KEY, siteKey = !!env.TURNSTILE_SITE_KEY;
  if (hosted && !secret) {
    items.push({ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Sign-up is closed: the bot check is not configured. Set both Turnstile keys to open it.' });
  } else if (secret !== siteKey) {
    items.push({ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Only one of the two Turnstile keys is set. Set both, or neither.' });
  }

  // Cloudflare connections are stored encrypted: without the key the dashboard cannot connect Cloudflare.
  if (!hasEncryptionKey(env)) {
    items.push(hosted
      ? { id: 'cloudflare_connections', severity: 'note', setting: 'TOKEN_ENCRYPTION_KEY', message: 'There is no TOKEN_ENCRYPTION_KEY, so customers cannot connect Cloudflare from the dashboard.' }
      : { id: 'cloudflare_connections', severity: 'action', setting: 'TOKEN_ENCRYPTION_KEY', message: "Cloudflare can't be connected from the dashboard: there is no TOKEN_ENCRYPTION_KEY. Set one: openssl rand -base64 32 | sed 's/^/k1:/' | npx wrangler secret put TOKEN_ENCRYPTION_KEY" });
  }

  // Rate limits: a missing ratelimit binding fails open, so the hosted service must have every one.
  // This is the one place that reports them (it replaces reading /api/me's dns_preview_limiter).
  if (hosted) {
    const missing = (['API_LIMITER', 'AUTH_LIMITER', 'MCP_LIMITER', 'OAUTH_TOKEN_LIMITER', 'MCP_ANON_LIMITER', 'DNS_PREVIEW_LIMITER'] as const).filter(name => !env[name]);
    if (missing.length) {
      items.push({
        id: 'rate_limits', severity: 'action', setting: missing.join(', '),
        message: `${missing.length === 1 ? 'A rate limit binding is' : `${missing.length} rate limit bindings are`} missing, so the requests ${missing.length === 1 ? 'it counts' : 'they count'} are not limited${missing.includes('MCP_LIMITER') || missing.includes('API_LIMITER') ? ', and agents are refused until MCP_LIMITER and API_LIMITER are both bound' : ''}. Add the ratelimit bindings from wrangler.jsonc to this Worker.`,
      });
    }
  }

  // Report intake: authentication settings and caps hit recently (src/reports/auth-status.ts).
  items.push(...await intakeSetupFindings(env));
  items.push(...reportIntakePreflightItems(env)); // the fixed report address: INTAKE_DOMAIN and who may connect (src/hosted/report-intake-check.ts)

  // Booking link: the day-14 follow-up email offers a call through it, and hosted dashboards show it as "Talk to Max".
  // Hosted uses the same https-only rule as the dashboard link (helpUrl), so this check and the link always agree.
  if (hosted && !helpUrl(env)) {
    items.push({ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No https booking link is set (BOOKING_URL), so the dashboard shows no "Talk to Max" link and the day-14 follow-up email, which offers a call, is held until there is one.' });
  } else if (!hosted && sequenceEnabled(env) && !bookingUrl(env)) {
    items.push({ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link is set (BOOKING_URL, an http or https address), so the day-14 follow-up email, which offers a call, is held until there is one.' });
  }

  // Public reports share this database with sign-in and report intake, so their storage has a total budget; say when it is near.
  const reports = await publicReportStorage(env);
  if (reports?.near_limit) {
    const full = reports.stored_bytes >= reports.total_budget_bytes;
    items.push({
      id: 'public_reports', severity: full ? 'action' : 'note', setting: 'PUBLIC_REPORTS_TOTAL_BYTES',
      message: full
        ? 'Stored public reports have used their whole storage budget, so no new report is made (existing ones still open). Delete reports or raise PUBLIC_REPORTS_TOTAL_BYTES.'
        : `Stored public reports use ${reports.used_percent}% of their storage budget. At 100% no new report is made; delete reports or raise PUBLIC_REPORTS_TOTAL_BYTES.`,
    });
  }

  // Hosted billing (src/billing/preflight.ts): configured, not configured, or misconfigured with the reason.
  const billing = await billingPreflight(env);
  items.push(...billing.items);

  // Product analytics (docs/analytics.md): a POSTHOG_* setting present but unusable says why it is off (never the value).
  const analytics = analyticsState(env);
  if (analytics.state === 'misconfigured') items.push({ id: 'product_analytics', severity: 'note', setting: analytics.setting, message: analytics.reason });

  return { mode: hosted ? 'saas' : 'self-host', agents: agentAvailability(env), items, ...(reports ? { public_reports: reports } : {}), ...(billing.status ? { billing: billing.status } : {}) };
}
