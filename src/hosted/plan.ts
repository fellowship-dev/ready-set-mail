// The hosted plan, in one place: what a workspace holds, what an add costs, who may add, and the lease every plan change runs under.
//
//   Unit        a domain with all its subdomains (the organizational domain, packages/dns-checks/src/org-domain.ts is the one Public Suffix source).
//   Allowance   the one unit a person holds free, in exactly one workspace they own (workspaces.free_owner_user_id, unique).
//   Billable    units in the workspace minus the allowance it holds (floor 0): the quantity of its subscription. Only the server writes it.
//
// With HOSTED_PLAN off (the default) or on a self-hosted instance nothing here limits anything: callers get today's row cap and nothing else.
// Reading is never blocked by any rule here (rule 8): this module decides what may be ADDED.
import { forWorkspace, planLookups, type DomainRoom, type SubscriptionRow } from '@ready-set-mail/db';
import { organizationalDomain } from '@ready-set-mail/dns-checks';
import { billingEnabled, type BillingEnv } from '../billing/config';
import { isInstanceOwner } from '../funnel/routes';
import type { BoundEnv } from '../index';
import { getMode } from '../tenancy/mode';
import { hostedEnabled } from './config';
import { planHelpUrl, planLimits } from './plan-limits';

export type PlanMode = 'off' | 'free_one_domain';
type Db = D1Database;

/** The plan model in force. Only a hosted instance (MODE=saas, SAAS_ENABLED=1) can have it on. */
export function planMode(env: BillingEnv & { HOSTED_PLAN?: string }): PlanMode {
  return hostedEnabled(env) && env.HOSTED_PLAN?.trim().toLowerCase() === 'free_one_domain' ? 'free_one_domain' : 'off';
}
export const planEnforced = (env: BillingEnv & { HOSTED_PLAN?: string }): boolean => planMode(env) === 'free_one_domain';
/** The paid path exists: the plan is enforced AND billing is configured. Otherwise the free limits apply and more domains are "talk to us". */
export const paidPathAvailable = (env: BillingEnv & { HOSTED_PLAN?: string }): boolean => planEnforced(env) && billingEnabled(env);

/** Subdomain rows one free unit keeps (memo C3). The rest of a domain's subdomains are counted under the domain. */
export const FREE_SUBDOMAIN_ROWS = 50;
/** Invitations a day per free workspace (invitations are mail from this service; joining is always free). */
export const FREE_INVITES_PER_DAY = 20;
/** A safety bound on live rows of one workspace under the plan (units are capped separately). */
export const PLAN_ROW_SAFETY = 500;

/** The unit a name belongs to: its organizational domain, else the name itself. */
export const unitOf = (domain: string): string => organizationalDomain(domain) ?? domain.trim().toLowerCase().replace(/\.$/, '');

/** Subscription statuses in which new paid domains may be added. */
const isActive = (status: string): boolean => status === 'active' || status === 'trialing';
/** Statuses that leave the plan standing but pause adding: Stripe is still retrying the payment. `unpaid` (retries over) and `canceled` lapse it. */
const isSoft = (status: string): boolean => status === 'past_due';

/** `pending`: the first payment of a new subscription waits for the owner's bank (3-D Secure); the domains added with it are visibly pending. */
export type SubscriptionState = 'none' | 'active' | 'pending' | 'payment_problem' | 'lapsed';
export const subscriptionState = (sub: Pick<SubscriptionRow, 'status' | 'lapsed_at'> | null): SubscriptionState =>
  !sub ? 'none' : sub.lapsed_at ? 'lapsed' : isActive(sub.status) ? 'active' : sub.status === 'incomplete' ? 'pending' : isSoft(sub.status) ? 'payment_problem' : 'lapsed';

export interface PlanState {
  workspaceId: string;
  /** The plan is enforced for this workspace (HOSTED_PLAN on, hosted). */
  enforced: boolean;
  /** Owned by the person who runs the instance: today's caps only. Derived from the owners' verified emails, never from a request. */
  exempt: boolean;
  plan: 'free' | 'payg';
  holdsAllowance: boolean;
  allowanceUserId: string | null;
  units: number;
  billable: number;
  pausedUnits: number;
  subscription: SubscriptionRow | null;
  subscriptionState: SubscriptionState;
  /** A paid domain may be added now (an active subscription, or none yet and the plan can be started). */
  canAddPaid: boolean;
  /** A free workspace that holds more than its allowance (it grew before the plan): everything keeps working, the next add asks. */
  grandfathered: boolean;
  /** Rows by unit, for listings (billable domains and the like). */
  rows: { id: number; domain: string; org: string; paused: boolean; pending: boolean; created_at: number }[];
  revision: number;
  customerId: string | null;
}

/** Fill in `org_domain` for rows that have none. The plan counts units from it, so this runs before any decision. */
export async function ensureOrgDomains(db: Db, workspaceId: string): Promise<void> {
  await forWorkspace(db, workspaceId).plan.fillOrgDomains(unitOf);
}

export async function isOperatorWorkspace(env: Pick<BoundEnv, 'MODE' | 'OWNER_EMAIL'>, db: Db, workspaceId: string): Promise<boolean> {
  if (!env.OWNER_EMAIL?.trim()) return false;
  for (const email of await planLookups(db).ownerEmails(workspaceId)) {
    if (isInstanceOwner(env, { kind: 'session', email, role: 'owner', workspaceId })) return true;
  }
  return false;
}

export async function loadPlanState(env: BoundEnv, db: Db, workspaceId: string): Promise<PlanState> {
  const q = forWorkspace(db, workspaceId).plan;
  await ensureOrgDomains(db, workspaceId);
  const [ws, rows, sub] = await Promise.all([q.get(), q.rows(), q.subscription.get()]);
  const enforced = planEnforced(env);
  const exempt = enforced && (await isOperatorWorkspace(env, db, workspaceId));
  const orgs = new Set(rows.map((r) => r.org_domain ?? r.domain));
  const paused = new Set(rows.filter((r) => r.paused_at).map((r) => r.org_domain ?? r.domain));
  const holdsAllowance = !!ws?.free_owner_user_id;
  const units = orgs.size;
  const subState = subscriptionState(sub);
  const plan = ws?.plan ?? 'free';
  return {
    workspaceId, enforced, exempt, plan, holdsAllowance, allowanceUserId: ws?.free_owner_user_id ?? null,
    units, billable: Math.max(0, units - (holdsAllowance ? 1 : 0)), pausedUnits: [...paused].filter((o) => orgs.has(o)).length,
    subscription: sub, subscriptionState: subState,
    canAddPaid: paidPathAvailable(env) && !exempt && (subState === 'active' || subState === 'none' || subState === 'lapsed'),
    grandfathered: enforced && !exempt && plan === 'free' && units > (holdsAllowance ? 1 : 0) && paused.size === 0,
    rows: rows.map((r) => ({ id: r.id, domain: r.domain, org: r.org_domain ?? r.domain, paused: !!r.paused_at, pending: !!r.payment_pending_at, created_at: r.created_at })),
    revision: ws?.plan_revision ?? 0,
    customerId: ws?.stripe_customer_id ?? null,
  };
}

/** Is this workspace held to the free plan's limits (HOSTED_PLAN on, on the free plan, not the operator's)? A lapsed workspace is free again. */
export async function isFreePlan(env: BoundEnv, db: Db, workspaceId: string): Promise<boolean> {
  if (!planEnforced(env)) return false;
  const ws = await forWorkspace(db, workspaceId).plan.get();
  if (!ws || ws.plan !== 'free') return false;
  return !(await isOperatorWorkspace(env, db, workspaceId));
}

/** Billable units after adding `n` new units to a workspace in this state. */
export const billableAfter = (s: Pick<PlanState, 'units' | 'holdsAllowance'>, n: number): number => Math.max(0, s.units + n - (s.holdsAllowance ? 1 : 0));

/**
 * Proof that a plan change is running under the workspace's lease: the only way to ask for room beyond the allowance. It cannot be built
 * outside `withPlanLock`, so a request, an agent or an import cannot start a paid domain by passing a flag.
 */
export class PlanGrant {
  /** @internal */
  constructor(readonly workspaceId: string, readonly unitMax: number, readonly extraUnits: number) {}
}

/** The insert rule for a new domain row: what the SQL of the insert itself enforces. */
export function insertRoom(env: BoundEnv, state: PlanState, domain: string, grant?: PlanGrant): DomainRoom {
  const org = unitOf(domain);
  const caps = planLimits(env);
  if (!state.enforced || state.exempt) return { maxDomains: caps?.domainsPerWorkspace, org };
  if (grant && grant.workspaceId !== state.workspaceId) throw new Error('plan: a grant belongs to one workspace');
  const free = !grant ? (state.holdsAllowance ? 1 : 0) : grant.unitMax;
  // A workspace that already holds more than the allowance (grandfathered, or paused after a lapse) keeps what it has; only NEW units are refused.
  return { org, units: { max: free, rowMax: PLAN_ROW_SAFETY, ...(state.plan === 'free' ? { subdomainMax: FREE_SUBDOMAIN_ROWS } : {}) } };
}

// ── The lease ───────────────────────────────────────────────

export class PlanBusyError extends Error {
  constructor() { super('Another change to this plan is being made.'); this.name = 'PlanBusyError'; }
}

export interface PlanLock {
  readonly workspaceId: string;
  readonly token: string;
  /** The state, read after the lease was taken: decide from this, never from anything read before. */
  state: PlanState;
  /** Ask for room for `n` more units than the workspace holds now. Refused beyond the plan's unit cap. */
  grant(n: number): PlanGrant | null;
  /** Bump the revision and return it (every Stripe write of this change derives its idempotency key from it). */
  revision(): Promise<number>;
  /** Re-read the state (after rows were added or removed under the lease). */
  refresh(): Promise<PlanState>;
}

/**
 * Run `fn` under the workspace's lease: one plan change at a time per workspace, whatever the Worker instance. Not acquired:
 * PlanBusyError (the caller answers 409 plan_busy, or for a removal, retries once and goes on). The lease expires by itself.
 */
export async function withPlanLock<T>(env: BoundEnv, db: Db, workspaceId: string, now: () => number, fn: (lock: PlanLock) => Promise<T>): Promise<T> {
  const q = forWorkspace(db, workspaceId).plan;
  const token = crypto.randomUUID();
  if (!(await q.lock.acquire(token, now()))) throw new PlanBusyError();
  try {
    const lock: PlanLock = {
      workspaceId, token, state: await loadPlanState(env, db, workspaceId),
      grant(n) {
        const cap = planLimits(env)?.domainsPerWorkspace;
        const target = lock.state.units + n;
        if (cap !== undefined && target > cap) return null;
        return new PlanGrant(workspaceId, target, n);
      },
      async revision() {
        const r = await q.lock.bump(token);
        if (r === null) throw new PlanBusyError(); // the lease was lost: nothing more may be written
        return r;
      },
      async refresh() { lock.state = await loadPlanState(env, db, workspaceId); return lock.state; },
    };
    return await fn(lock);
  } finally {
    await q.lock.release(token).catch(() => undefined);
  }
}

// ── What the person is told ─────────────────────────────────

export interface PlanRequiredBody {
  error: string;
  code: 'plan_required';
  /** The paid path exists on this instance; false: "talk to us" (help_url). */
  paid_available: boolean;
  help_url: string | null;
  domain?: string;
  /** Free workspace that grew before the plan: the choice the owner is asked to make. */
  grandfather?: { units: number; billable_now: number; billable_after: number } | null;
  /** The person asking can confirm a paid domain themself (their browser session, as the workspace owner). */
  needs_owner: boolean;
}

/** The 402 answer for an add that does not fit the free allowance. One sentence, no pricing: the confirm step states the money. */
export function planRequiredBody(env: BoundEnv, state: PlanState, opts: { domain?: string; session: boolean }): PlanRequiredBody {
  const paid = paidPathAvailable(env);
  const base = state.holdsAllowance || state.units > 0
    ? 'Your free plan covers one domain and all its subdomains.'
    : 'This workspace does not include a free domain.';
  const next = !paid ? ' For more domains, talk to us.'
    : opts.session ? ' The workspace owner can add more domains with pay as you go.'
    : ' Adding more domains needs the workspace owner: sign in to the dashboard and choose Add domain.';
  return {
    error: base + next, code: 'plan_required', paid_available: paid, help_url: planHelpUrl(env), ...(opts.domain ? { domain: opts.domain } : {}),
    grandfather: state.grandfathered ? { units: state.units, billable_now: state.billable, billable_after: billableAfter(state, 1) } : null,
    needs_owner: true,
  };
}

/** A free workspace keeps this many subdomain rows under one domain (memo C3). */
export const SUBDOMAIN_CAP_MESSAGE = `This domain has more than ${FREE_SUBDOMAIN_ROWS} subdomains sending mail; the rest are counted under the domain.`;
