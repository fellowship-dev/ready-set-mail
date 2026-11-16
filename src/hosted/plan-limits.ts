// Hosted plan caps: how many workspaces one person may own and how many domains one workspace may hold.
// Self-host has no caps. The numbers are variables, not constants, so a plan can be raised without a deploy of code.
import type { Env } from '../index';
import { helpUrl } from '../funnel/config';
import { getMode } from '../tenancy/mode';

export const DEFAULT_MAX_WORKSPACES_PER_USER = 5;
export const DEFAULT_MAX_DOMAINS_PER_WORKSPACE = 10;

export type PlanLimitKind = 'workspaces_per_user' | 'domains_per_workspace';
export interface PlanLimits { workspacesPerUser: number; domainsPerWorkspace: number }

type LimitEnv = Pick<Env, 'MODE' | 'MAX_WORKSPACES_PER_USER' | 'MAX_DOMAINS_PER_WORKSPACE' | 'BOOKING_URL'>;

/** A positive integer string, else the default ('0', '-1', 'abc', '1.5' and '' all fall back). */
function positiveInt(raw: string | undefined, fallback: number): number {
  const v = raw?.trim() ?? '';
  if (!/^\d+$/.test(v)) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The caps in force, or null on a self-hosted instance (no caps). */
export function planLimits(env: Partial<LimitEnv>): PlanLimits | null {
  if (getMode(env) !== 'saas') return null;
  return {
    workspacesPerUser: positiveInt(env.MAX_WORKSPACES_PER_USER, DEFAULT_MAX_WORKSPACES_PER_USER),
    domainsPerWorkspace: positiveInt(env.MAX_DOMAINS_PER_WORKSPACE, DEFAULT_MAX_DOMAINS_PER_WORKSPACE),
  };
}

/** The booking link, only when it is https: the dashboard renders it as a link. */
export function planHelpUrl(env: Partial<LimitEnv>): string | null {
  return helpUrl(env);
}

export function planLimitBody(env: Partial<LimitEnv>, kind: PlanLimitKind, max: number) {
  return {
    error: kind === 'domains_per_workspace'
      ? `This workspace has reached its limit of ${max} ${max === 1 ? 'domain' : 'domains'}.`
      : `You have reached the limit of ${max} ${max === 1 ? 'workspace' : 'workspaces'} you can own.`,
    code: 'plan_limit' as const,
    limit: { kind, max },
    help_url: planHelpUrl(env),
  };
}

/** HTTP 403 for a cap that is reached. */
export function planLimitResponse(env: Partial<LimitEnv>, kind: PlanLimitKind, max: number): Response {
  return Response.json(planLimitBody(env, kind, max), { status: 403 });
}

// ── MTA-STS ──────────────────────────────────────────────────
// A separate capability from the domain and workspace caps: available to every hosted workspace once the operator has set it up, with an
// instance-wide ceiling on policy hosts (Cloudflare for SaaS includes 100 custom hostnames; more cost the operator money, so the ceiling is theirs
// to raise: MAX_POLICY_HOSTS). Self-host has no gate.

export type MtaStsRefusal = 'not_configured' | 'not_allowed' | 'ceiling';

export interface MtaStsFacts {
  /** The hosted service has MODE, SAAS_ENABLED, INTAKE_DOMAIN and the three POLICY_HOST_* settings. */
  configured: boolean;
  /** HOSTED_CONNECT_REPORTS admits this workspace (workspaceMayConnectReports): without it its TLS reports would be refused. */
  reportsAdmitted: boolean;
  /** Custom hostnames the instance holds now. */
  hostsInUse: number;
  /** This domain would take one more custom hostname (a new saas_hostname policy host). */
  needsHostname: boolean;
  /** The ceiling in force (maxPolicyHosts). */
  max: number;
}

export type MtaStsGate =
  | { allowed: true }
  | { allowed: false; reason: MtaStsRefusal; body: { error: string; code: 'mta_sts_unavailable'; reason: MtaStsRefusal; limit?: { kind: 'policy_hosts'; max: number }; help_url: string | null } };

const MTA_STS_SENTENCE: Readonly<Record<MtaStsRefusal, (max: number) => string>> = Object.freeze({
  not_configured: () => 'MTA-STS is not available on this service yet: the operator has not set up policy hosting.',
  not_allowed: () => 'MTA-STS is not open to this workspace yet: its TLS reports could not be received.',
  ceiling: (max) => `This service has reached its limit of ${max} MTA-STS policy ${max === 1 ? 'host' : 'hosts'}.`,
});

/** May this workspace turn MTA-STS on for a domain? Pure: the caller supplies the facts. A refusal carries a 403 body in the shape of planLimitBody. */
export function mayUseMtaSts(env: Partial<LimitEnv>, facts: MtaStsFacts): MtaStsGate {
  if (getMode(env) !== 'saas') return { allowed: true };
  const reason: MtaStsRefusal | null = !facts.configured ? 'not_configured' : !facts.reportsAdmitted ? 'not_allowed' : facts.needsHostname && facts.hostsInUse >= facts.max ? 'ceiling' : null;
  if (!reason) return { allowed: true };
  return {
    allowed: false, reason,
    body: { error: MTA_STS_SENTENCE[reason](facts.max), code: 'mta_sts_unavailable', reason, ...(reason === 'ceiling' ? { limit: { kind: 'policy_hosts' as const, max: facts.max } } : {}), help_url: planHelpUrl(env) },
  };
}
