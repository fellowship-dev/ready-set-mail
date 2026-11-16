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

import { lookupDmarc, planReportAddress, recordHasAddress, ruaEntries, ruaEntryAddress, type InheritedPlan, type ReportAddressPlan, type Resolver } from '@ready-set-mail/dns-checks';
import type { CfClient, CfDnsRecord } from '../tenancy/cf-client';
import { dmarcRecordProblem, findDmarcRecord, writeDmarcRecord } from '../dmarc/dns-record';
import { plainCloudflareError } from '../onboarding/errors';
import { planDmarc, readInherited, type InheritedRead } from '../onboarding/dmarc-plan';
import { resolverFor } from '../dns/resolver';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { reportVisibility, type ReportVisibility } from '../reports/visibility';
import { hostedConfig, hostedEnabled } from './config';
import { fixedReportAddress, isFixedReportAddress, workspaceMayConnectReports } from './fixed-address';
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
 * address. written: connected, and Cloudflare's record lists the address but public DNS does not show it yet (a write that has not
 * propagated). waiting: listed, no COUNTED report since connecting. receiving: listed AND at least one COUNTED report (an authenticated
 * registry reporter, reporter_tier 'counted') stored since connecting. unknown: connected, but the DNS lookup failed, so nothing can
 * be said about the record. Uncounted reports never make a domain "received"; they are counted apart and named.
 */
export type ReportAddressState = 'not_connected' | 'not_published' | 'written' | 'waiting' | 'receiving' | 'unknown';

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
  /**
   * Whether "Apply" can write this domain's DMARC record: a Cloudflare connection reaches its zone (the test onboarding-status uses).
   * False when reports cannot be connected for the domain.
   */
  apply_via_cloudflare: boolean;
  /**
   * Apply reaches the zone: the live record as Cloudflare holds it, what Apply would do about it and the hash the apply must carry
   * (`reviewReportRecord`). Null without Cloudflare: a record carrying the address is not offered to paste before the domain is connected
   * (the intake refuses reports for a domain that never was).
   */
  review: ReportRecordReview | null;
  /** When the domain follows its organizational domain's record: that domain, if this workspace has it, and whether its reports are connected. */
  parent: { domain_id: number; domain: string; connected: boolean } | null;
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
async function refusalOf(tenant: TenantContext, domain: DomainRow, workspaceMay?: boolean): Promise<Refusal | null> {
  return refusalFrom(domain, () => isDomainProven(tenant, domain), () => workspaceMay ?? workspaceMayConnectReports(tenant.env as BoundEnv, tenant.workspaceId));
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
export async function reportConnectFor(tenant: TenantContext, domain: DomainRow, workspaceMay?: boolean): Promise<ReportConnect | null> {
  if (!hostedEnabled(tenant.env)) return null;
  if (!reportIntakeDomain(tenant.env)) return unavailable();
  if (await tenant.scope.hosted.get(domain.id)) return connectAnswer(true, null);
  return connectAnswer(false, await refusalOf(tenant, domain, workspaceMay));
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
  const write = managed_by || refusal ? null : await reach(tenant, domain);
  const review = write ? await reviewOf(await readLive(tenant, domain, deps, write), domain, fixedReportAddress(intakeDomain)) : null;
  const apply_via_cloudflare = !!review;
  if (address) {
    counts = await tenant.scope.intake.reportsAround(domain.id, connected_at);
    // Since the connection began, by when we RECEIVED the reports: a report covers the previous day, so its period starts before the connection.
    visibility = await reportVisibility(tenant, domain.id, connected_at ?? 0, undefined, 'received');
    const lookup = await lookupDmarc(deps.resolver ?? resolverFor(tenant.env), domain.domain);
    const checked_at = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    dns = { checked_at, error: lookup.status === 'error' ? (lookup.error ?? 'DNS lookup failed') : null, plan: planReportAddress(lookup, address) };
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
    else if (dns.plan.kind !== 'published') state = review?.outcome.kind === 'present' ? 'written' : 'not_published';
    else state = counts.counted_since > 0 ? 'receiving' : 'waiting';
  }

  return {
    available: true, domain_id: domain.id, domain: domain.domain, managed_by, can_connect: !refusal, refusal, address,
    connected_at, last_report_at: counts.last_counted_since, counted_since_connect: counts.counted_since, reports_since_connect: counts.since,
    reports_before_connect: counts.before, visibility, state, dns, apply_via_cloudflare, review, parent,
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

// ── The one function that writes our report address into a DMARC record ───────────────────────────────
//
// Both entry points call it: the domain page's Connect reports panel (POST /api/domains/:id/report-address/apply) and the first-run
// review (`dns-apply`, step dmarc: src/onboarding/plan.ts builds its hosted DMARC write from `reviewReportRecord`, src/onboarding/routes.ts
// applies it through `applyReportRecord`). Nothing else puts our address into a record: the policy routes (apply-dmarc, PATCH dmarc) refuse
// to (`reportAddressChangeIn`, `policyWriteRua`). ADR 0020.
//
//  - The record comes from the LIVE record and the person's explicit choice, never from a record a browser sends: every tag stays byte for
//    byte except the rua= list; every address stays exactly as published except the one the person chose to replace; the policy never changes.
//  - Live is the domain's Cloudflare zone when a connection reaches it, public DNS otherwise (the first read of a name with no record of its
//    own is the policy it inherits, as the first-run plan reads it).
//  - The review carries the live value and its hash; the apply carries the reviewed hash and the choice, reads live again and refuses
//    (409 `record_changed`, with the fresh review) when it differs. Nothing is connected or written on that refusal.
//  - Address count (RFC 7489 §6.2, ADR 0020): ours is only ever the first or second address. Fewer than two published: ours goes after them. Two or
//    more: the person picks which of the first two it replaces, or leaves the record as it is.
//  - Before it connects or writes it asks the same questions as connectReports (hosted intake on, not hosted records, ownership proven,
//    workspace admitted by HOSTED_CONNECT_REPORTS). It connects the domain BEFORE it writes the record that carries our address.

/** What the person decided: add ours after the addresses there, or replace one of the first two (`address` as published, `mailto:` included). */
export type ReportChoice = { kind: 'add' } | { kind: 'replace'; address: string };

/** Where the live record was read: the domain's Cloudflare zone, or public DNS when no connection reaches the zone. */
export type ReportSource = 'cloudflare' | 'public_dns';

export type ReportRecordOutcome =
  /** Apply writes `after` (create, or update of the record that is there). */
  | { kind: 'write'; action: 'create' | 'update'; after: string; reason: string }
  /** The record already lists our address: Apply only connects the domain. */
  | { kind: 'present'; reason: string }
  /** Two or more addresses: one of the first two must be chosen. `reason` is the rule in words. */
  | { kind: 'choose'; existing: string[]; options: { replaces: string; after: string }[]; reason: string }
  /** Nothing can be written, and why (several records, an invalid p=, a failed read, a record that would not stay valid). */
  | { kind: 'blocked'; reason: string };

export interface ReportRecordReview {
  source: ReportSource;
  /** `_dmarc.<domain>`. */
  name: string;
  /** The address Apply adds. */
  address: string;
  /** The domain's own record as read, null when it has none (or when it has several: see `outcome`). */
  now: string | null;
  /** No own record: the record of the organizational domain that applies today. */
  inherited: { from: string; record: string } | null;
  /** Of the live value and its source: the apply must carry it. */
  hash: string;
  outcome: ReportRecordOutcome;
}

interface LiveDmarc {
  source: ReportSource;
  /** The DMARC TXT records at `_dmarc.<domain>`, as published. */
  own: string[];
  existing: CfDnsRecord | null;
  inherited: InheritedRead;
  /** Set when a Cloudflare connection reaches the zone: where a write goes. */
  write: { cf: CfClient; zoneId: string } | null;
  /** The read itself failed: no decision can be made. */
  failure: string | null;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The Cloudflare client and zone that reach this domain, or null when no connection does (the test `applyViaCloudflare` makes, with the zone). */
async function reach(tenant: TenantContext, domain: Pick<DomainRow, 'domain'>): Promise<LiveDmarc['write']> {
  if (!tenant.hasCloudflare()) return null;
  try {
    const cf = await tenant.cfFor(domain.domain);
    return { cf, zoneId: (await cf.zoneFor(domain.domain)).id };
  } catch { return null; }
}

async function readLive(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps, write: LiveDmarc['write']): Promise<LiveDmarc> {
  const resolver = deps.resolver ?? resolverFor(tenant.env);
  if (write) {
    try {
      const live = await findDmarcRecord(write.cf, write.zoneId, `_dmarc.${domain.domain}`);
      const own = live.kind === 'one' ? [live.content] : live.kind === 'many' ? live.contents : [];
      return { source: 'cloudflare', own, existing: live.kind === 'one' ? live.record : null, inherited: own.length ? { kind: 'none' } : await readInherited(resolver, domain.domain), write, failure: null };
    } catch (e) {
      const failure = plainCloudflareError(e);
      return { source: 'cloudflare', own: [], existing: null, inherited: { kind: 'unknown', reason: failure }, write, failure: `Could not read the DMARC record from Cloudflare: ${failure}` };
    }
  }
  const r = await lookupDmarc(resolver, domain.domain);
  const none: InheritedRead = { kind: 'none' };
  const base = { source: 'public_dns' as const, existing: null, write: null, failure: null };
  if (r.status === 'error') return { ...base, own: [], inherited: { kind: 'unknown', reason: r.error ?? 'lookup failed' }, failure: `Could not read the DMARC record from public DNS: ${r.error ?? 'lookup failed'}` };
  if (r.status === 'none') return { ...base, own: [], inherited: none };
  if (r.status === 'multiple') return r.inherited ? { ...base, own: [], inherited: { kind: 'unknown', reason: `${r.foundAt?.replace(/^_dmarc\./, '')} has several DMARC records` } } : { ...base, own: r.rawRecords ?? [], inherited: none };
  if (!r.inherited) return { ...base, own: [r.record!.raw], inherited: none };
  return { ...base, own: [], inherited: { kind: 'inherited', parent: r.organizationalDomain ?? r.foundAt!.replace(/^_dmarc\./, ''), record: r.record!.raw } };
}

/** The decision for the live record: from the one builder (planDmarc), hosted rules on. */
function outcomeOf(live: LiveDmarc, address: string): ReportRecordOutcome {
  if (live.failure) return { kind: 'blocked', reason: live.failure };
  const d = planDmarc({ ownRecords: live.own, inherited: live.inherited, rua: address, ruaLimit: true });
  if (d.action === 'skip') return { kind: 'blocked', reason: d.reason };
  if (d.action === 'none') return { kind: 'present', reason: d.reason };
  if (d.action === 'choose') return { kind: 'choose', existing: d.existing, options: d.options.map((o) => ({ replaces: o.replaces, after: o.record })), reason: d.reason };
  const problem = dmarcRecordProblem(d.record);
  if (problem) return { kind: 'blocked', reason: `The DMARC record with the report address added would not be valid (${problem}), so it is not written. Fix the record at your DNS provider first.` };
  return { kind: 'write', action: d.action, after: d.record, reason: d.reason };
}

async function reviewOf(live: LiveDmarc, domain: DomainRow, address: string): Promise<ReportRecordReview> {
  const inherited = live.inherited.kind === 'inherited' ? { from: live.inherited.parent, record: live.inherited.record } : null;
  return {
    source: live.source, name: `_dmarc.${domain.domain}`, address,
    now: live.own.length === 1 ? live.own[0]! : null, inherited,
    hash: await digest({ source: live.source, own: live.own, inherited, failure: live.failure }),
    outcome: outcomeOf(live, address),
  };
}

/** What Apply would do for this domain now, read from the live record (see the module comment above). Reads only. */
export async function reviewReportRecord(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}): Promise<ReportRecordReview> {
  const address = fixedReportAddress(requireIntake(tenant));
  await assertNotHosted(tenant, domain);
  const refusal = await refusalFor(tenant, domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
  return reviewOf(await readLive(tenant, domain, deps, await reach(tenant, domain)), domain, address);
}

/** The apply's refusal when the live record is not the reviewed one: 409 `record_changed`, with the fresh review to show. */
export class ReportRecordChanged extends ReportAddressError {
  constructor(readonly review: ReportRecordReview) {
    super('The record changed since you looked. Review it again before anything is written.', 409);
    this.name = 'ReportRecordChanged';
  }
}

/**
 * Connect the domain and write our address into its DMARC record, as reviewed. `reviewed` is the hash of the review the person saw. Throws
 * ReportAddressError (403 refused, 409 blocked or no Cloudflare, 400 a choice that does not fit the record) or ReportRecordChanged (409);
 * a failed Cloudflare write after the domain was connected throws as it is: the domain stays connected and the status says what is true.
 */
export async function applyReportRecord(
  tenant: TenantContext, domain: DomainRow, input: { reviewed: string; choice: ReportChoice }, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext,
): Promise<{ wrote: boolean }> {
  const address = fixedReportAddress(requireIntake(tenant));
  await assertNotHosted(tenant, domain);
  const refusal = await refusalFor(tenant, domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
  const write = await reach(tenant, domain);
  if (!write) throw new ReportAddressError(`No Cloudflare connection reaches the zone of ${domain.domain}, so Ready Set Mail cannot write its DMARC record. Add the report address at your DNS provider.`, 409);
  const live = await readLive(tenant, domain, deps, write);
  const review = await reviewOf(live, domain, address);
  if (review.hash !== input.reviewed) throw new ReportRecordChanged(review);

  const o = review.outcome;
  let record: string | null = null;
  if (o.kind === 'blocked') throw new ReportAddressError(o.reason, 409);
  if (o.kind === 'choose') {
    const { choice } = input;
    const picked = choice.kind === 'replace' ? o.options.find((x) => x.replaces === choice.address) : undefined;
    if (!picked) throw new ReportAddressError(o.reason, 400);
    record = picked.after;
  } else if (input.choice.kind !== 'add') {
    throw new ReportAddressError('There is no address to replace in this record: it lists fewer than two.', 400);
  } else if (o.kind === 'write') record = o.after;

  // The domain is connected BEFORE the record that carries our address is written: that address never reaches DNS for a domain intake would refuse.
  await connectReports(tenant, domain, deps, actor, ctx);
  if (record) {
    const written = await writeDmarcRecord(write.cf, write.zoneId, domain.domain, live.existing, record);
    logAudit(tenant, {
      actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
      action: live.existing ? 'dns.update' : 'dns.create', resource_type: 'dns_record', resource_id: written?.id ?? '', resource_name: review.name,
      before_value: live.existing ? { type: 'TXT', name: review.name, content: review.now } : null,
      after_value: { type: 'TXT', name: review.name, content: record },
    }, ctx);
  }
  return { wrote: record !== null };
}

/**
 * Hosted: the report address a DMARC record carries when a policy route (apply-dmarc, PATCH dmarc) rewrites it. Never one of ours: an address
 * at the intake domain (shared or token) is written only by applyReportRecord, so a workspace that is not admitted, or a domain that is not
 * proven, can never get it through another route. Self-host: the stored address, as ever.
 */
export function policyWriteRua(tenant: TenantContext, storedAddress: string | null | undefined): string | null {
  const intake = reportIntakeDomain(tenant.env);
  const host = (storedAddress ?? '').trim().toLowerCase().split('@').pop();
  return intake && host === intake.toLowerCase() ? null : storedAddress ?? null;
}

/**
 * Hosted: a record the policy routes are asked to write that adds our address or drops a report address published now. Returns the plain
 * sentence, or null when the record is fine. `live` is the record published now (null: none).
 */
export function reportAddressChangeIn(tenant: TenantContext, live: string | null, record: string): string | null {
  if (!hostedEnabled(tenant.env)) return null;
  const intake = reportIntakeDomain(tenant.env);
  if (intake && recordHasAddress(record, fixedReportAddress(intake)) && !(live && recordHasAddress(live, fixedReportAddress(intake)))) {
    return 'This record adds the Ready Set Mail report address. Use Connect reports on the domain page for that: it shows the record as it is now and connects the domain before it writes.';
  }
  const kept = new Set(ruaEntries(record).map(ruaEntryAddress));
  const dropped = live ? ruaEntries(live).filter((e) => !kept.has(ruaEntryAddress(e))) : [];
  return dropped.length ? `This record would remove ${dropped.join(', ')}, a report address published now. Keep it in the record, or remove it at your DNS provider.` : null;
}
