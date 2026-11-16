// Connecting a domain's DMARC reports on the hosted service (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN set).
//
// Every customer publishes the same fixed address, `rua@<INTAKE_DOMAIN>` (src/hosted/fixed-address.ts). Nothing is
// issued: connecting is the workspace saying "file this domain's reports here", recorded by setting the domain's
// `rua_address` to that address. The intake then files a report about the domain (or one of its subdomains) into the
// one workspace that proved ownership of it and connected it; anything else is refused. Disconnecting clears the
// address, and the intake refuses the domain's reports from then on.
//
// A domain whose reports arrive through hosted records keeps its token address (`rua+<token>@…`), managed by
// src/hosted/service.ts; this module reports that and changes nothing.
//
// Who: owners and admins (the router's member read-only rule refuses every write to members). What: a domain row only,
// so never a pending or lost claim (those live in domain_claims), never an evicted row, and never a row whose
// ownership was not proven ('legacy', from before ownership checks).

import { createResolver, domainAncestry, lookupDmarc, planReportAddress, recordHasAddress, ruaEntries, withoutReportAddress, type InheritedPlan, type ReportAddressPlan, type Resolver } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { reportVisibility, type ReportVisibility } from '../reports/visibility';
import { hostedConfig, hostedEnabled } from './config';
import { attributeReport, fixedReportAddress, isFixedReportAddress, workspaceMayConnectReports } from './fixed-address';
import { isDomainProven, provenDomainIds } from '../domains/ownership';
import type { BoundEnv } from '../index';
import { hashToken, intakeAddress, isTokenShaped, parseRecipient } from './tokens';

export class ReportAddressError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ReportAddressError';
  }
}

export interface ReportAddressDeps {
  resolver?: Resolver;
  now?: () => number;
}

type DomainRow = NonNullable<Awaited<ReturnType<TenantContext['scope']['domains']['getById']>>>;
type Actor = { id?: string | null; email?: string | null };

/**
 * not_connected: reports are not connected. not_published: connected, but the live DMARC record does not list the
 * address. waiting: listed, no COUNTED report since connecting. receiving: listed AND at least one COUNTED report (an authenticated
 * registry reporter, reporter_tier 'counted') stored since connecting. unknown: connected, but the DNS lookup failed, so nothing can
 * be said about the record. Uncounted reports never make a domain "received"; they are counted apart and named.
 */
export type ReportAddressState = 'not_connected' | 'not_published' | 'waiting' | 'receiving' | 'unknown';

export interface ReportAddressView {
  /** Report intake is configured on this deployment (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN). */
  available: true;
  domain_id: number;
  domain: string;
  /** Hosted records publish this domain's address; this API leaves it alone. */
  managed_by: 'hosted_records' | null;
  /** Whether an owner or admin may connect this domain's reports, and if not, why. */
  can_connect: boolean;
  refusal: string | null;
  /** The address to publish: the fixed hosted address (or a token address given earlier), once connected. */
  address: string | null;
  /** When the current connection began (null for an older token address). */
  connected_at: number | null;
  /** The newest COUNTED report stored since the connection began; how many counted, and all reports (counted or not), since then; reports before it apart. */
  last_report_at: number | null;
  counted_since_connect: number;
  reports_since_connect: number;
  reports_before_connect: number;
  /** What the dashboard must say besides the state (uncounted and not-stored reports), over the reports since connecting (src/reports/visibility.ts). */
  visibility: ReportVisibility | null;
  state: ReportAddressState;
  /** The live DMARC check, made only when connected. `plan` is null when the lookup failed. */
  dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | InheritedPlan | null } | null;
  /** When the domain follows its organizational domain's record: that domain, if this workspace has it, and whether its reports are connected. */
  parent: { domain_id: number; domain: string; connected: boolean } | null;
  /**
   * This name has no connection of its own, yet the intake files reports that name it as their policy domain under THIS row, through
   * the connection of the nearest connected, proven parent of this workspace (`attributeReport` then the gate in
   * src/email/dmarc-report.ts, which prefers a proven row of the subdomain). `not_connected` stays the truth about the row's own
   * address; this says reports about it still arrive. Mail from this name that a receiver lists inside the parent's own report stays
   * with the parent.
   */
  via_parent: { domain_id: number; domain: string } | null;
}

export type ReportIntakeStatus = { available: false } | ReportAddressView;

/** The intake domain when report intake is on, else null. Independent of the free check and of hosted records. */
export function reportIntakeDomain(env: TenantContext['env']): string | null {
  if (!hostedEnabled(env)) return null;
  return hostedConfig(env).intakeDomain ?? null;
}

/** Why reports cannot be connected, by kind: the dashboard's next step differs for each. */
export type ReportConnectRefusal = 'unavailable' | 'hosted_records' | 'ownership' | 'operator_only';

type ProofFacts = Pick<DomainRow, 'domain' | 'verified_via'>;
type Refusal = { kind: ReportConnectRefusal; reason: string };

/**
 * The one decision behind every refusal, from facts already read: `proven` (isDomainProven, or the page's provenDomainIds) and
 * `workspaceMay` (HOSTED_CONNECT_REPORTS for the workspace). Each is asked only when the checks before it passed.
 */
async function refusalFrom(domain: ProofFacts, proven: () => boolean | Promise<boolean>, workspaceMay: () => boolean | Promise<boolean>): Promise<Refusal | null> {
  if (domain.verified_via === 'legacy') return { kind: 'ownership', reason: `Ownership of ${domain.domain} is not proven in this workspace. Use "Prove again" on the domain's page to prove that you control it (your report history stays), then connect reports.` };
  if (!(await proven())) return { kind: 'ownership', reason: `${domain.domain} was added through a parent domain that is no longer in this workspace. Remove it and add it again to prove that you control it, then connect reports.` };
  if (!(await workspaceMay())) return { kind: 'operator_only', reason: 'On this server, only the operator\'s workspaces can connect reports.' };
  return null;
}

/** Why this domain's reports cannot be connected, with its kind, or null. Hosted records are handled by the callers. */
async function refusalOf(tenant: TenantContext, domain: DomainRow, workspaceMay?: boolean, proven?: boolean): Promise<Refusal | null> {
  return refusalFrom(domain, () => proven ?? isDomainProven(tenant, domain), () => workspaceMay ?? workspaceMayConnectReports(tenant.env as BoundEnv, tenant.workspaceId));
}

/** The connect answer once the hosted-records fact and the refusal are known (shared by the one-domain and the page paths). */
function connectAnswer(hosted: boolean, refusal: Refusal | null): ReportConnect {
  if (hosted) return { can_connect: false, refusal: 'Reports for this domain come through its hosted records.', refusal_kind: 'hosted_records' };
  return refusal ? { can_connect: false, refusal: refusal.reason, refusal_kind: refusal.kind } : { can_connect: true, refusal: null, refusal_kind: null };
}
const unavailable = (): ReportConnect => ({ can_connect: false, refusal: 'This server does not receive DMARC reports.', refusal_kind: 'unavailable' });

/** Why this domain's reports cannot be connected, or null. Hosted records are handled by the callers. */
async function refusalFor(tenant: TenantContext, domain: DomainRow): Promise<string | null> {
  return (await refusalOf(tenant, domain))?.reason ?? null;
}

export interface ReportConnect {
  can_connect: boolean;
  /** The connect panel's own words for why not (null when reports can be connected). */
  refusal: string | null;
  refusal_kind: ReportConnectRefusal | null;
}

/**
 * Whether this domain's reports can be connected here, per domain, in the connect panel's words: the overview and the
 * domain page decide each row from this. Null on an instance without hosted report intake (self-host: the deployment's
 * reports address is the one to publish). `workspaceMay`: HOSTED_CONNECT_REPORTS's answer for the workspace, when known.
 */
export async function reportConnectFor(tenant: TenantContext, domain: DomainRow, workspaceMay?: boolean, proven?: boolean): Promise<ReportConnect | null> {
  if (!hostedEnabled(tenant.env)) return null;
  if (!reportIntakeDomain(tenant.env)) return unavailable();
  if (await tenant.scope.hosted.get(domain.id)) return connectAnswer(true, null);
  return connectAnswer(false, await refusalOf(tenant, domain, workspaceMay, proven));
}

/**
 * reportConnectFor for every domain of a page, from three queries whatever its size (the workspace's domains, its hosted rows, and
 * HOSTED_CONNECT_REPORTS's answer), none on an instance without hosted report intake. Returns the answer for a domain id (null:
 * no such live domain, or no hosted intake here).
 */
export async function reportConnectForPage(tenant: TenantContext): Promise<(domainId: number) => ReportConnect | null> {
  if (!hostedEnabled(tenant.env)) return () => null;
  if (!reportIntakeDomain(tenant.env)) return () => unavailable();
  const [rows, hostedRows, may] = await Promise.all([tenant.scope.domains.list(), tenant.scope.hosted.list(), workspaceMayConnect(tenant)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const proven = provenDomainIds(rows);
  const hosted = new Set(hostedRows.map((h) => h.domain_id));
  const answers = new Map<number, ReportConnect>();
  await Promise.all(rows.map(async (r) => {
    answers.set(r.id, hosted.has(r.id) ? connectAnswer(true, null) : connectAnswer(false, await refusalFrom(r, () => proven.has(r.id), () => may)));
  }));
  return (id) => (byId.has(id) ? answers.get(id) ?? null : null);
}

/** HOSTED_CONNECT_REPORTS's answer for the workspace (one query for a page of domains). */
export async function workspaceMayConnect(tenant: TenantContext): Promise<boolean> {
  return workspaceMayConnectReports(tenant.env as BoundEnv, tenant.workspaceId);
}

/**
 * The domain's connected address: the fixed one, or a token address whose token is still the domain's current one
 * (an address given out before the fixed address existed keeps working). Anything else counts as not connected.
 */
async function connectedAddress(tenant: TenantContext, domain: DomainRow, intakeDomain: string): Promise<string | null> {
  if (isFixedReportAddress(domain.rua_address, intakeDomain)) return fixedReportAddress(intakeDomain);
  const rcpt = parseRecipient(domain.rua_address?.trim() ?? '');
  if (!rcpt || rcpt.base !== 'rua' || rcpt.host !== intakeDomain || !rcpt.tag || !isTokenShaped(rcpt.tag)) return null;
  const token = await tenant.scope.intake.get(domain.id);
  return token && (await hashToken(rcpt.tag)) === token.token_hash ? intakeAddress('rua', rcpt.tag, intakeDomain) : null;
}

/**
 * The connected parent this row's reports arrive through, or null. Exactly what the intake decides for a report about this name: who owns it
 * (`attributeReport`), then whether this row takes it from them (the gate in src/email/dmarc-report.ts prefers a proven row of the subdomain).
 * Call it only for a row with no connection of its own that is not refused (`refusalOf`) and not hosted.
 */
export async function reportsViaParent(tenant: TenantContext, domain: DomainRow, intakeDomain: string): Promise<{ domain_id: number; domain: string } | null> {
  const target = await attributeReport(tenant.env as BoundEnv & { DB: D1Database }, intakeDomain, domain.domain);
  if (!target || target.workspace_id !== tenant.workspaceId || target.domain_id === domain.id) return null;
  const row = await tenant.scope.domains.getById(target.domain_id);
  return row ? { domain_id: row.id, domain: row.domain } : null;
}

/**
 * The address a row's reports arrive at when it has none of its own (through its connected parent), else null: what its DNS record is compared with.
 * `known.proven`: the caller has just proved the row (a bulk import), so its proof is not read again from the workspace's whole domain list.
 */
export async function reportsAddressVia(tenant: TenantContext, domain: DomainRow, known: { proven?: boolean } = {}): Promise<string | null> {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain || domain.rua_address?.trim() || domainAncestry(domain.domain).length < 2) return null;
  if (!(await reportConnectFor(tenant, domain, undefined, known.proven))?.can_connect) return null;
  return (await reportsViaParent(tenant, domain, intakeDomain)) ? fixedReportAddress(intakeDomain) : null;
}

/**
 * The domain rows as the dashboard lists them. A row with no connection of its own whose reports arrive through its connected parent
 * (`reportsViaParent`) carries that connection's address as its `rua_address` and `reports_via`, so every page that asks "do reports reach
 * this name?" (the verdict, its next step, the DNS records) answers what the intake does, never "not connected" while reports arrive.
 */
export async function withReportsVia<R extends DomainRow>(tenant: TenantContext, rows: R[]): Promise<Array<R & { reports_via?: { domain_id: number; domain: string } }>> {
  const intakeDomain = reportIntakeDomain(tenant.env);
  const wanted = rows.filter((r) => !r.rua_address?.trim() && domainAncestry(r.domain).length > 1);
  if (!intakeDomain || wanted.length === 0) return rows;
  const connectFor = await reportConnectForPage(tenant);
  const via = new Map<number, { domain_id: number; domain: string }>();
  for (const r of wanted) {
    if (!connectFor(r.id)?.can_connect) continue; // refused (unproven, not admitted) or hosted records: nothing arrives here
    const v = await reportsViaParent(tenant, r, intakeDomain);
    if (v) via.set(r.id, v);
  }
  return rows.map((r) => (via.has(r.id) ? { ...r, rua_address: fixedReportAddress(intakeDomain), reports_via: via.get(r.id)! } : r));
}

export async function reportAddressStatus(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}): Promise<ReportIntakeStatus> {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) return { available: false };
  const managed_by = (await tenant.scope.hosted.get(domain.id)) ? 'hosted_records' as const : null;
  const refusal = managed_by ? 'Reports for this domain come through its hosted records.' : await refusalFor(tenant, domain);
  // A refused domain (unproven, or a workspace HOSTED_CONNECT_REPORTS does not admit) receives nothing: not connected,
  // whatever its stored address says.
  const address = managed_by || refusal ? null : await connectedAddress(tenant, domain, intakeDomain);
  const connected_at = address ? domain.reports_connected_at ?? null : null;

  let counts = { since: 0, counted_since: 0, last_counted_since: null as number | null, before: 0 };
  let dns: ReportAddressView['dns'] = null;
  let visibility: ReportVisibility | null = null;
  if (address) {
    counts = await tenant.scope.intake.reportsAround(domain.id, connected_at);
    // Since the connection began, by when we RECEIVED the reports: a report covers the previous day, so its period starts before the connection.
    visibility = await reportVisibility(tenant, domain.id, connected_at ?? 0, undefined, 'received');
    const lookup = await lookupDmarc(deps.resolver ?? createResolver(), domain.domain);
    const checked_at = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    dns = { checked_at, error: lookup.status === 'error' ? (lookup.error ?? 'DNS lookup failed') : null, plan: planReportAddress(lookup, address) };
  }
  let via_parent: ReportAddressView['via_parent'] = null;
  if (!address && !managed_by && !refusal) {
    via_parent = await reportsViaParent(tenant, domain, intakeDomain);
  }
  let parent: ReportAddressView['parent'] = null;
  if (dns?.plan?.kind === 'inherited') {
    const row = await tenant.scope.domains.getByName(dns.plan.from);
    if (row) parent = { domain_id: row.id, domain: row.domain, connected: !!(await connectedAddress(tenant, row, intakeDomain)) };
  }

  // Evidence only: received means published in live DNS AND a COUNTED report stored since this connection began.
  let state: ReportAddressState = 'not_connected';
  if (address) {
    if (!dns?.plan) state = 'unknown';
    else if (dns.plan.kind !== 'published') state = 'not_published';
    else state = counts.counted_since > 0 ? 'receiving' : 'waiting';
  }

  return {
    available: true, domain_id: domain.id, domain: domain.domain, managed_by, can_connect: !refusal, refusal, address,
    connected_at, last_report_at: counts.last_counted_since, counted_since_connect: counts.counted_since, reports_since_connect: counts.since,
    reports_before_connect: counts.before, visibility, state, dns, parent, via_parent,
  };
}

function requireIntake(tenant: TenantContext): string {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) throw new ReportAddressError('Report intake is not enabled on this server', 404);
  return intakeDomain;
}

async function assertNotHosted(tenant: TenantContext, domain: DomainRow): Promise<void> {
  if (await tenant.scope.hosted.get(domain.id)) throw new ReportAddressError('Reports for this domain come through its hosted records. Manage them there.', 409);
}

function audit(tenant: TenantContext, domain: DomainRow, action: string, actor: Actor | undefined, ctx: ExecutionContext | undefined) {
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action, resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
  }, ctx);
}

/** Connect: file this domain's reports here. Already connected: nothing changes and the status comes back (`created: false`). */
export async function connectReports(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<{ created: boolean; status: ReportIntakeStatus }> {
  const intakeDomain = requireIntake(tenant);
  await assertNotHosted(tenant, domain);
  const refusal = await refusalFor(tenant, domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
  if (await connectedAddress(tenant, domain, intakeDomain)) return { created: false, status: await reportAddressStatus(tenant, domain, deps) };
  await tenant.scope.intake.connect(domain.id, fixedReportAddress(intakeDomain), Math.floor((deps.now?.() ?? Date.now()) / 1000));
  audit(tenant, domain, 'reports.connect', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return { created: true, status: await reportAddressStatus(tenant, fresh, deps) };
}

/** Disconnect at once: the intake refuses this domain's reports from now on (a token address, if any, stops too). Stored reports stay. */
export async function disconnectReports(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<ReportIntakeStatus> {
  requireIntake(tenant);
  await assertNotHosted(tenant, domain);
  await tenant.scope.intake.disconnect(domain.id);
  audit(tenant, domain, 'reports.disconnect', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return reportAddressStatus(tenant, fresh, deps);
}


// ── Writing the report address into a DMARC record the product writes itself ──────────────────────────

/**
 * What a DMARC write for this domain does about reports, from the existing connect rules (reportConnectFor, connectReports):
 *  - none: this deployment takes no hosted reports, or the domain's reports come through hosted records: the record is written as given;
 *  - refused: reports cannot be connected for this domain or workspace (an unproven domain, or HOSTED_CONNECT_REPORTS does not admit the
 *    workspace): the record is written without our address, and `reason` says why in the connect panel's words;
 *  - ready: the address to carry (the fixed one, or the token address the domain already has).
 */
export type ReportWritePlan = { kind: 'none' } | { kind: 'refused'; reason: string } | { kind: 'ready'; address: string; connected: boolean };

export async function reportAddressForWrite(tenant: TenantContext, domain: DomainRow, workspaceMay?: boolean): Promise<ReportWritePlan> {
  const rc = await reportConnectFor(tenant, domain, workspaceMay);
  if (!rc || rc.refusal_kind === 'unavailable' || rc.refusal_kind === 'hosted_records') return { kind: 'none' };
  if (!rc.can_connect) return { kind: 'refused', reason: rc.refusal ?? 'Reports cannot be connected for this domain.' };
  const intakeDomain = reportIntakeDomain(tenant.env)!;
  const current = await connectedAddress(tenant, domain, intakeDomain);
  return { kind: 'ready', address: current ?? fixedReportAddress(intakeDomain), connected: !!current };
}

export type ReportMerge = 'present' | 'added' | 'limit';

/**
 * `record` with `address` in its rua= list, by the existing rule (planReportAddress): ours is added beside the addresses already there and
 * nothing else changes (never a weaker policy; nobody's address is dropped). A record that already lists two addresses never gets a third:
 * it is left as it is and the answer is `limit` (the person chooses what to replace in the reports panel). `liveRecord` is what is published
 * now: a record that lists ours already is `present`, and one that grew past two with ours only because the caller appended it is cut back.
 */
export function mergeReportAddress(domain: string, record: string, address: string, liveRecord?: string | null): { record: string; outcome: ReportMerge } {
  if (recordHasAddress(record, address)) {
    const grewHere = !(liveRecord && recordHasAddress(liveRecord, address));
    if (grewHere && ruaEntries(record).length > 2) return { record: withoutReportAddress(record, address), outcome: 'limit' };
    return { record, outcome: 'present' };
  }
  const plan = planReportAddress({ status: 'found', domain, record: { raw: record, valid: true, issues: [], subdomainPolicy: '' }, foundAt: null, inherited: false, organizationalDomain: null }, address);
  if (plan?.kind === 'add') return { record: plan.record, outcome: 'added' };
  if (plan?.kind === 'published') return { record: plan.record, outcome: 'present' };
  return { record, outcome: 'limit' };
}
