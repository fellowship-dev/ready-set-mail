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

/**
 * The hosted plan "pay as you go" (src/billing/plan.ts), when the free place is full and the workspace has no card: the refusal says what a card is for,
 * names the claims waiting for proof (they count), and tells a non-owner who can add the card. HTTP 402, code `card_required`.
 */
export function cardRequiredBody(env: Partial<LimitEnv>, max: number, held: number, waiting: string[], canManage: boolean) {
  const base = planLimitWaitingBody(env, max, held, waiting);
  const first = 'Your free plan covers one domain, and a domain waiting for proof counts.';
  const names = waiting.length === 0 ? '' : ` Waiting for proof: ${waiting.length <= 3 ? waiting.join(', ') : `${waiting.slice(0, 3).join(', ')} and ${waiting.length - 3} more`}; Remove on a card frees its place.`;
  const error = canManage
    ? `${first} To add more, add a card in Settings → Billing: each extra domain is $50 a year (or $5 a month), charged only once it is proven.${names}`
    : `${first}${names} Ask the workspace owner to add a card in Settings → Billing.`;
  return { ...base, error, code: 'card_required' as const, can_manage: canManage, prices: { month: 'USD 5', year: 'USD 50' } };
}

/** The HTTP status of a refusal body: 402 for `card_required`, 403 for a cap that is reached. */
export const planRefusalStatus = (body: { code?: string }): 402 | 403 => (body.code === 'card_required' ? 402 : 403);

/** HTTP 403 for a cap that is reached. */
export function planLimitResponse(env: Partial<LimitEnv>, kind: PlanLimitKind, max: number): Response {
  return Response.json(planLimitBody(env, kind, max), { status: 403 });
}
