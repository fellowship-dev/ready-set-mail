// MTA-STS settings (ADR 0015). The hosted service serves `https://mta-sts.<customer domain>/.well-known/mta-sts.txt` from this Worker, which
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
  /** Localhost only (cfApiBase ignores anything else): a local run's fake Cloudflare. */
  CLOUDFLARE_API_BASE_URL?: string;
}

/** What a policy file says senders may cache it for. One day in both modes (ADR 0015): a mistake or an MX change heals within a day. */
export const DEFAULT_MAX_AGE = 86400;
/** Policy hosts (Cloudflare for SaaS custom hostnames) one instance holds: the hostnames the Cloudflare plan includes. */
export const DEFAULT_MAX_POLICY_HOSTS = 100;
/** Enforce is offered after this long in testing (CHANGELOG 1.2.0), and only with evidence (src/mta-sts/evidence.ts). */
export const ENFORCE_AFTER_SECONDS = 7 * 86400;
/** How far back TLS failures weigh on the enforce decision. */
export const EVIDENCE_WINDOW_SECONDS = 14 * 86400;
/** Configs the daily job visits per run, oldest check first (about ten subrequests each; the default ceiling is the same number). */
export const REFRESH_PER_RUN = 100;
/** Operator-side leftovers the daily job removes per run. */
export const RECONCILE_PER_RUN = 20;

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
