// Hosted plan caps: how many workspaces one person may own and how many domains one workspace may hold.
// Self-host has no caps. The numbers are variables, not constants, so a plan can be raised without a deploy of code.
import type { Env } from '../index';
import { helpUrl } from '../funnel/config';
import type { BoundEnv } from '../index';
import { getMode } from '../tenancy/mode';
import { allowed, parseAllow, type Allow } from './allow';

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

/** What a workspace has used of its places: the names of its live domains, and of the domains still waiting for proof (open claims). */
export interface DomainUse { domains: string[]; waiting: string[] }

export type DomainRoom = { ok: true } | { ok: false; cap: number; held: number; waiting: string[] };

/**
 * THE room rule, for every way of adding a domain (typed, claim, Cloudflare import, parent proof, bulk import, certificate-log import, "prove again"):
 * a workspace has `cap` places and a domain AND a domain waiting for proof each take one, so room = cap − (domains + waiting claims).
 * A name the workspace already holds needs no room, and a claim that becomes its own domain needs none either (it already has its place).
 * Returns ok, or what is in the way. Its SQL twin, for the insert that must be atomic, is `slotsUsed` in packages/db/src/queries/plan-limit.ts.
 */
export function domainRoom(cap: number, use: DomainUse, name: string): DomainRoom {
  const held = new Set(use.domains);
  if (held.has(name)) return { ok: true };
  const waiting = use.waiting.filter(n => !held.has(n));
  const after = new Set([...held, ...waiting, name]);
  return after.size <= cap ? { ok: true } : { ok: false, cap, held: held.size, waiting: waiting.filter(n => n !== name) };
}

/** The same cap, reached by domains plus domains still waiting for proof: nobody publishes a TXT record for a domain that could never be added. Names the waiting claims and where to remove them. */
export function planLimitWaitingBody(env: Partial<LimitEnv>, max: number, held: number, waiting: string[]) {
  const body = planLimitBody(env, 'domains_per_workspace', max);
  if (waiting.length === 0) return body;
  const slots = `${max} ${max === 1 ? 'domain' : 'domains'}`;
  const names = waiting.length <= 3 ? waiting.join(', ') : `${waiting.slice(0, 3).join(', ')} and ${waiting.length - 3} more`;
  const state = held === 0 ? `${slots}, and ${waiting.length === 1 ? 'one is' : `${waiting.length} are`} waiting for proof` : `${slots}: it has ${held}, and ${waiting.length} more ${waiting.length === 1 ? 'is' : 'are'} waiting for proof`;
  return { ...body, error: `This workspace can hold ${state} (${names}). Use Remove on ${waiting.length === 1 ? 'its' : 'their'} card to free ${waiting.length === 1 ? 'the place' : 'the places'}.`, waiting };
}

/** HTTP 403 for a cap that is reached. */
export function planLimitResponse(env: Partial<LimitEnv>, kind: PlanLimitKind, max: number): Response {
  return Response.json(planLimitBody(env, kind, max), { status: 403 });
}

// ── Capabilities ─────────────────────────────────────────────
// A separately gated ability of a workspace or a domain (SPF flattening first; owner, Nov 16: "an add on and it needs its own price, per domain").
// `capability` is the single answer to "may this workspace use it": asked by every route, the dashboard (/api/me), the daily job and the next-step
// links. Another capability (MTA-STS, #188's `mayUseMtaSts`) is a new name in `Capability` and a new entry in `GATES`, never a second function. The price
// is open (docs/adr/OPEN.md), so nothing here knows one; the hosted plan attaches a subscription to a capability by adding reasons here.

export type Capability = 'spf_flattening';
/** `self_host`: self-hosted installations have every capability. `operator_setting`: the operator admitted this workspace. `not_enabled`: it is not available to it. */
export type CapabilityReason = 'self_host' | 'operator_setting' | 'not_enabled';
export interface CapabilityAnswer { allowed: boolean; reason: CapabilityReason }
/** What a capability is asked about: the workspace, and the domain where the capability is per domain (the seam for a per-domain subscription; unused until the plan has one). */
export interface CapabilityScope { workspaceId: string; domainId?: number }

type CapabilityEnv = Pick<BoundEnv, 'MODE' | 'OWNER_EMAIL' | 'DB' | 'HOSTED_SPF_FLATTENING'>;

/** HOSTED_SPF_FLATTENING: unset, empty or not understood = off; `owner`, `all`, or workspace ids (`ws_...`, comma separated, with or without `owner`). */
export function spfFlatteningSetting(env: Pick<BoundEnv, 'HOSTED_SPF_FLATTENING'>): Allow {
  return parseAllow(env.HOSTED_SPF_FLATTENING, { fallback: 'off', ids: true });
}

/** What each capability asks on the hosted service (self-host is answered before this). */
const GATES: Readonly<Record<Capability, (env: CapabilityEnv, scope: CapabilityScope) => Promise<CapabilityAnswer>>> = Object.freeze({
  spf_flattening: async (env: CapabilityEnv, scope: CapabilityScope): Promise<CapabilityAnswer> => (await allowed(spfFlatteningSetting(env), env, scope.workspaceId)) ? { allowed: true, reason: 'operator_setting' } : { allowed: false, reason: 'not_enabled' },
});

/**
 * May this workspace use this capability (for this domain)? Turning a capability OFF for a domain that has it is never refused by this answer:
 * callers keep Disable available (src/spf/refresh.ts).
 */
export async function capability(env: CapabilityEnv, name: Capability, scope: CapabilityScope): Promise<CapabilityAnswer> {
  if (getMode(env) !== 'saas') return { allowed: true, reason: 'self_host' };
  return GATES[name](env, scope);
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
  not_configured: () => 'MTA-STS is not available on this service: the operator has not set up policy hosting.',
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
