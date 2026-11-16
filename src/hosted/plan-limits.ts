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

/** HTTP 403 for a cap that is reached. */
export function planLimitResponse(env: Partial<LimitEnv>, kind: PlanLimitKind, max: number): Response {
  return Response.json(planLimitBody(env, kind, max), { status: 403 });
}

// ── Add-ons ──────────────────────────────────────────────────
// A separately priced capability of a domain (SPF flattening first; owner, Nov 16: "an add on and it needs its own price, per domain").
// The price is open (docs/adr/OPEN.md), so nothing here knows one: this is the single answer to "may this workspace use it", asked by
// every route, the dashboard (/api/me), the daily job and the next-step links. The hosted plan (HOSTED_PLAN, src/hosted/plan.ts) attaches a
// subscription to it by adding reasons here.

export type AddOn = 'spf_flattening';
/** `self_host`: self-hosted installations have every add-on. `operator_setting`: the operator admitted this workspace. `not_enabled`: it is not available to it. */
export type AddOnReason = 'self_host' | 'operator_setting' | 'not_enabled';
export interface AddOnAccess { allowed: boolean; reason: AddOnReason }

type AddOnEnv = Pick<BoundEnv, 'MODE' | 'OWNER_EMAIL' | 'DB' | 'HOSTED_SPF_FLATTENING'>;

/** HOSTED_SPF_FLATTENING: unset, empty or not understood = off; `owner`, `all`, or workspace ids (`ws_...`, comma separated, with or without `owner`). */
export function spfFlatteningSetting(env: Pick<BoundEnv, 'HOSTED_SPF_FLATTENING'>): Allow {
  return parseAllow(env.HOSTED_SPF_FLATTENING, { fallback: 'off', ids: true });
}

/**
 * May this workspace use this add-on (for this domain)? `domainId` is the seam for a per-domain subscription: unused until the plan has one.
 * Turning an add-on OFF for a domain that has it is never refused by this answer: callers keep Disable available (src/spf/refresh.ts).
 */
export async function addOnAccess(env: AddOnEnv, addOn: AddOn, scope: { workspaceId: string; domainId?: number }): Promise<AddOnAccess> {
  if (getMode(env) !== 'saas') return { allowed: true, reason: 'self_host' };
  const setting = addOn === 'spf_flattening' ? spfFlatteningSetting(env) : parseAllow(undefined, { fallback: 'off', ids: true });
  return (await allowed(setting, env, scope.workspaceId)) ? { allowed: true, reason: 'operator_setting' } : { allowed: false, reason: 'not_enabled' };
}
