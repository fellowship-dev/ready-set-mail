// MTA-STS settings (ADR 0021). The hosted service serves `https://mta-sts.<customer domain>/.well-known/mta-sts.txt` from this Worker, which
// needs three operator settings besides the hosted ones (docs/hosted.md, Environment):
//   POLICY_HOST_ZONE    the operator's Cloudflare for SaaS zone, e.g. readysetmail.com
//   POLICY_HOST_TARGET  the hostname customers point `mta-sts.<domain>` at (a proxied, originless record in that zone, set as its fallback origin)
//   POLICY_HOST_TOKEN   secret: "SSL and Certificates Write" and "Workers Routes Write" on that one zone
// Self-host needs none of them.

import { hostedConfig, hostedEnabled, type HostedEnv } from '../hosted/config';

export interface PolicyHostEnv extends HostedEnv {
  POLICY_HOST_ZONE?: string;
  POLICY_HOST_TARGET?: string;
  POLICY_HOST_TOKEN?: string;
  MAX_POLICY_HOSTS?: string;
  WORKER_NAME?: string;
  /** Subrequests one invocation may make (Workers Paid 10,000, the default; Workers Free 50): the daily job's budget follows it. */
  SUBREQUEST_LIMIT?: string;
  /** Localhost only (cfApiBase ignores anything else): a local run's fake Cloudflare. */
  CLOUDFLARE_API_BASE_URL?: string;
}

/**
 * What a policy file says senders may cache it for, by mode (ADR 0021). RFC 8461 section 3.2: max_age is "typically in the range of weeks or greater"
 * (a short one lets an attacker wait out the cache), and Proton serves 604800 in enforce; section 5: start in testing, where a mistake or an MX change
 * should heal within a day. `none` (the removal policy, section 8.3) is one day: "a small max_age (e.g., one day)".
 */
export const MAX_AGE_TESTING = 86400;
export const MAX_AGE_ENFORCE = 604800;
export const MAX_AGE_NONE = 86400;
export const maxAgeFor = (mode: 'testing' | 'enforce' | 'none'): number => (mode === 'enforce' ? MAX_AGE_ENFORCE : mode === 'none' ? MAX_AGE_NONE : MAX_AGE_TESTING);
/** Policy hosts (Cloudflare for SaaS custom hostnames) one instance holds: the hostnames the Cloudflare plan includes. */
export const DEFAULT_MAX_POLICY_HOSTS = 100;
/** Enforce is offered after this long in testing (CHANGELOG 1.2.0), and only with evidence (src/mta-sts/evidence.ts). */
export const ENFORCE_AFTER_SECONDS = 7 * 86400;
/** A setup that is not finished this long after it was turned on is stopped: Cloudflare deletes a custom hostname that was not validated within 7 days anyway. */
export const SETUP_EXPIRES_AFTER_SECONDS = 7 * 86400;
export const SETUP_EXPIRED_NOTICE = 'Setup was not finished within 7 days, so it was stopped. Turn it on again to restart.';
/** How far back TLS failures weigh on the enforce decision. */
export const EVIDENCE_WINDOW_SECONDS = 14 * 86400;
/**
 * The daily job's subrequest budget. developers.cloudflare.com/workers/platform/limits/ (read 2026-11-16), "Subrequests per invocation": Workers Free 50, Workers Paid
 * 10,000 (up to 10M); a subrequest is "any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1", so DNS lookups, Cloudflare API calls, the
 * policy fetch AND each D1 statement count. The default is the Paid limit; a Workers Free install sets SUBREQUEST_LIMIT=50 and the job shrinks to match.
 * One run uses at most half of the limit: rows * SUBREQUESTS_PER_ROW (measured with margin in test/mta-sts/budget.test.ts) plus SUBREQUEST_RESERVE for the shared work (zone and
 * route lookups, finishing retired policies, leftover cleanup). Rows are visited oldest check first, so with R enabled rows and P per run every row is visited at least every
 * ceil(R / P) days: one day up to P rows (P is 100 at the default limit, the same number as the default ceiling of policy hosts), two days up to 2P, and so on.
 */
export const DEFAULT_SUBREQUEST_LIMIT = 10_000;
export const SUBREQUESTS_PER_ROW = 25;
export const SUBREQUEST_RESERVE = 600;
export const SUBREQUEST_MARGIN = 0.5;
/** Configs the daily job visits per run at most (the default ceiling of policy hosts is the same number, so every hosted row is reached daily). */
export const REFRESH_PER_RUN = 100;
/** Operator-side leftovers the daily job removes per run, and retired policies it finishes per run (each about 4 and 15 subrequests: inside SUBREQUEST_RESERVE). */
export const RECONCILE_PER_RUN = 20;

export function subrequestLimit(env: object): number {
  const v = (env as { SUBREQUEST_LIMIT?: string }).SUBREQUEST_LIMIT?.trim() ?? '';
  const n = /^\d+$/.test(v) ? Number.parseInt(v, 10) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_SUBREQUEST_LIMIT;
}

/** Rows one run visits: what half the subrequest limit allows after the reserve, at most REFRESH_PER_RUN, at least one (so a Workers Free install still moves). */
export function refreshRowsPerRun(env: object): number {
  const room = subrequestLimit(env) * SUBREQUEST_MARGIN - SUBREQUEST_RESERVE;
  return Math.max(1, Math.min(REFRESH_PER_RUN, Math.floor(room / SUBREQUESTS_PER_ROW)));
}

/** Shared work per run (leftover cleanup, finishing retired policies): the usual count where the reserve fits, one on a tiny limit. */
export function maintenancePerRun(env: object): number {
  return subrequestLimit(env) >= 2 * SUBREQUEST_RESERVE ? RECONCILE_PER_RUN : 1;
}

/** Every enabled row is visited at least this often, in days (oldest check first). */
export const refreshIntervalDays = (rows: number, env: object): number => Math.max(1, Math.ceil(rows / refreshRowsPerRun(env)));

const clean = (v: string | undefined): string | undefined => v?.trim().toLowerCase().replace(/^\.+|\.+$/g, '') || undefined;

export interface PolicyHostConfig { zone: string; target: string; token: string }

/** The three operator settings, or null when any is missing or the target is not a name inside the zone. */
export function policyHostConfig(env: PolicyHostEnv): PolicyHostConfig | null {
  const zone = clean(env.POLICY_HOST_ZONE);
  const target = clean(env.POLICY_HOST_TARGET);
  const token = env.POLICY_HOST_TOKEN?.trim();
  if (!zone || !target || !token || !target.endsWith(`.${zone}`)) return null;
  return { zone, target, token };
}

/** Is the hosted service set up to serve policies: hosted, a report address for the TLS reports, and the three settings. */
export function mtaStsHostedConfigured(env: PolicyHostEnv): boolean {
  return hostedEnabled(env) && !!hostedConfig(env).intakeDomain && !!policyHostConfig(env);
}

/** The instance-wide ceiling of policy hosts (a positive integer; anything else keeps the default). */
export function maxPolicyHosts(env: Pick<PolicyHostEnv, 'MAX_POLICY_HOSTS'>): number {
  const v = env.MAX_POLICY_HOSTS?.trim() ?? '';
  const n = /^\d+$/.test(v) ? Number.parseInt(v, 10) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_POLICY_HOSTS;
}
