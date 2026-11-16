// MTA-STS for one domain (ADR 0015): availability, the status a person reads, turning it on, checking it, changing its mode and turning it off.
//
// One path for hosted and self-host: the three DNS records go into the CUSTOMER's zone (through their Cloudflare connection when one reaches the
// zone, by hand otherwise) and the policy is served by this Worker on `mta-sts.<domain>`, reached the way src/mta-sts/policy-host.ts says.
//
// Order of work, every time: checks → policy host (hosted) → the customer's records → store. Whatever was created is undone when a later step
// fails. The `_mta-sts` TXT (the id senders refetch on) is written LAST, once the policy is served (RFC 8461 §8.1), and on every change the
// stored policy changes BEFORE the TXT does. Enable always starts in testing. Enforce needs evidence (src/mta-sts/evidence.ts). Disable is offered
// only in testing, and once senders that fetched an enforce policy no longer hold it.

import { intakeLookups, type DomainRow, type MtaStsRow } from '@ready-set-mail/db';
import { createResolver, lookupMx, normalizeName, type Resolver } from '@ready-set-mail/dns-checks';
import { cfFailureBody } from '../api/cf-failure';
import { logAudit } from '../audit/log';
import { isDomainProven } from '../domains/ownership';
import { REPORTS_DOMAIN_MISSING } from '../domains/bulk';
import { removalAction, type DnsRemoval, type KeptRecord } from '../dns/removal';
import {
  createPolicyHostCname, createPolicyIdRecord, createTlsRptRecord, deprovisionMtaSts, generatePolicyId, getWorkerRoute, nextPolicyId, policyIdRecordValue,
  tlsRptRecordValue, updateMtaStsTxtRecord, type MtaStsAuditOpts, type MtaStsRemoval,
} from '../email/mta-sts';
import { hostedEnabled, hostedConfig } from '../hosted/config';
import { tlsReportAddress, workspaceMayConnectReports } from '../hosted/fixed-address';
import { mayUseMtaSts } from '../hosted/plan-limits';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';
import {
  DEFAULT_MAX_AGE, EVIDENCE_WINDOW_SECONDS, maxPolicyHosts, mtaStsHostedConfigured, policyHostConfig,
} from './config';
import { disableRule, enforceReadiness, maxAgeWords, splitHosts, type Readiness } from './evidence';
import { OperatorZone, policyHostname, strategyFor, type PolicyHostStrategy } from './policy-host';

export interface Result { status: number; body: Record<string, unknown> }
export interface Actor { id?: string | null; email?: string | null }
export interface Ctx { tenant: TenantContext; domain: DomainRow; actor?: Actor; ec?: ExecutionContext }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({ status, body: { error, ...extra } });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const norm = (s: string) => normalizeName(s);

export type Unavailable = 'hosted_records' | 'unproven' | 'not_configured' | 'not_allowed' | 'ceiling' | 'zone_subdomain' | 'needs_cloudflare' | 'reports_domain_missing';
export type Via = 'cloudflare' | 'manual';

// ── Availability ─────────────────────────────────────────────

export interface Availability {
  available: boolean;
  reason: Unavailable | 'none';
  message: string | null;
  /** The status and body a write answers with when it is not available. */
  refusal: Result | null;
  via: Via | null;
  strategy: PolicyHostStrategy | null;
}

const SENTENCES: Readonly<Record<Exclude<Unavailable, 'not_configured' | 'not_allowed' | 'ceiling' | 'reports_domain_missing'>, string>> = Object.freeze({
  hosted_records: "This domain uses hosted records: its _smtp._tls record is already a pointer to them, so MTA-STS cannot be turned on here.",
  unproven: 'Prove that you own this domain first: MTA-STS publishes a policy under its name.',
  zone_subdomain: "MTA-STS is not available for this name: it sits inside the zone that serves other customers' policies, where it cannot get a certificate of its own.",
  needs_cloudflare: "MTA-STS needs a Cloudflare connection that reaches this domain's zone: the policy is served through Cloudflare.",
});

/** Can MTA-STS be turned on for this domain, and how (via a connection or by hand; which policy host)? Whatever the answer, an existing config stays readable. */
export async function availability(tenant: TenantContext, domain: DomainRow): Promise<Availability> {
  const env = tenant.env;
  const saas = getMode(env) === 'saas';
  const no = (reason: Unavailable, message: string, status: number, body: Record<string, unknown> = {}): Availability => ({
    available: false, reason, message, refusal: fail(status, message, { code: 'mta_sts_unavailable', reason, ...body }), via: null, strategy: null,
  });

  if (saas && hostedEnabled(env) && (await tenant.scope.hosted.get(domain.id))) return no('hosted_records', SENTENCES.hosted_records, 409);

  const reaches = await tenant.reachesZone(domain.domain);
  if (!saas) {
    if (!reaches) return no('needs_cloudflare', SENTENCES.needs_cloudflare, 400, { code: 'cloudflare_not_connected' });
    if (!tenant.settings.reportsDomain) return no('reports_domain_missing', REPORTS_DOMAIN_MISSING, 400);
    return { available: true, reason: 'none', message: null, refusal: null, via: 'cloudflare', strategy: strategyFor(env, domain.domain) };
  }

  const configured = mtaStsHostedConfigured(env);
  const strategy = strategyFor(env, domain.domain);
  const gateFor = async (needsHostname: boolean) => mayUseMtaSts(env, {
    configured,
    reportsAdmitted: configured ? await workspaceMayConnectReports(env as never, tenant.workspaceId) : true,
    hostsInUse: configured && needsHostname ? await intakeLookups(tenant.db).saasHostnameCount() : 0,
    needsHostname,
    max: maxPolicyHosts(env),
  });
  const gate = await gateFor(strategy?.customHostname ?? true);
  if (!gate.allowed && gate.reason === 'not_configured') return { available: false, reason: gate.reason, message: gate.body.error, refusal: { status: 403, body: gate.body }, via: null, strategy: null };
  if (!(await isDomainProven(tenant, domain as never))) return no('unproven', SENTENCES.unproven, 403);
  if (!strategy) return no('zone_subdomain', SENTENCES.zone_subdomain, 422);
  if (!gate.allowed) return { available: false, reason: gate.reason, message: gate.body.error, refusal: { status: 403, body: gate.body }, via: null, strategy: null };
  return { available: true, reason: 'none', message: null, refusal: null, via: reaches ? 'cloudflare' : 'manual', strategy };
}

// ── Reading DNS ──────────────────────────────────────────────

export type MxPreview = { status: 'ok' | 'none' | 'error'; hosts: string[]; error: string | null };

/** The domain's MX hosts now. An error is kept apart from "none": a DNS outage is not "the MX records were removed". */
export async function readMx(domain: string, resolver: Resolver = createResolver()): Promise<MxPreview> {
  const mx = await lookupMx(resolver, domain);
  if (mx.status === 'error') return { status: 'error', hosts: [], error: mx.error ?? 'DNS lookup failed' };
  const hosts = mx.hosts.map((h) => h.host);
  return hosts.length ? { status: 'ok', hosts, error: null } : { status: 'none', hosts: [], error: null };
}

/** The address TLS reports go to: the shared hosted address, or this workspace's reports domain on self-host. */
export function tlsRptAddress(tenant: TenantContext): string | null {
  if (getMode(tenant.env) === 'saas') {
    const d = hostedConfig(tenant.env).intakeDomain;
    return d ? tlsReportAddress(d) : null;
  }
  const rd = tenant.settings.reportsDomain;
  return rd ? `tls-rpt@${rd}` : null;
}

/** Where `mta-sts.<d>` is to point. Hosted: the operator's target. Self-host: this Worker's own host (null when it cannot be told). */
async function policyTarget(tenant: TenantContext, domain: string, s: PolicyHostStrategy): Promise<{ target: string | null; problem: string | null }> {
  if (getMode(tenant.env) === 'saas') return { target: policyHostConfig(tenant.env)?.target ?? null, problem: null };
  if (!s.cnameProxied) return { target: null, problem: null };
  try { return { target: await getWorkerRoute(tenant, domain), problem: null }; } catch (e) { return { target: null, problem: e instanceof Error ? e.message : String(e) }; }
}

export interface RecordView {
  purpose: 'policy_host' | 'tls_rpt' | 'policy_id';
  type: 'CNAME' | 'TXT';
  name: string;
  /** The exact value. `policy_id` before enable shows an id that is only an example: the real one is made when it is published. */
  value: string | null;
  /** CNAME only: proxied (orange cloud) or DNS only (grey cloud). */
  proxied?: boolean;
  /** Ready Set Mail wrote it through the connection (false: the person adds it). */
  written: boolean;
  /** The person should add it now (by hand; false once it is in place or while it must wait for the certificate). */
  add_now: boolean;
  note?: string;
}

function recordsFor(domain: string, o: { target: string | null; proxied: boolean; address: string | null; policyId: string | null; row: MtaStsRow | null; strategy: PolicyHostStrategy | null }): RecordView[] {
  const { row } = o;
  const manual = row ? row.via === 'manual' : false;
  const certWait = !!row && row.policy_host === 'saas_hostname' && row.ch_ssl_status !== 'active';
  return [
    {
      purpose: 'policy_host', type: 'CNAME', name: `mta-sts.${domain}`, value: o.target, proxied: o.proxied, written: !!row?.cname_record_id,
      add_now: manual && row!.state === 'waiting_records',
      note: o.proxied ? 'Proxied (orange cloud).' : 'DNS only (grey cloud): Cloudflare issues the certificate for this name after the record resolves.',
    },
    {
      purpose: 'tls_rpt', type: 'TXT', name: `_smtp._tls.${domain}`, value: o.address ? tlsRptRecordValue(o.address) : null, written: !!row?.tls_rpt_record_id,
      add_now: manual && row!.state === 'waiting_records',
    },
    {
      purpose: 'policy_id', type: 'TXT', name: `_mta-sts.${domain}`, value: policyIdRecordValue(o.policyId ?? 'YYYYMMDDHHMMSS'), written: !!row?.mta_sts_record_id,
      add_now: manual && row!.state === 'waiting_txt',
      note: row ? (certWait ? 'Published last, once the certificate for the policy host is active.' : undefined) : 'Published last, once the policy is served. The id is the time it is published.',
    },
  ];
}

const certificateOf = (r: MtaStsRow) => (r.policy_host === 'saas_hostname' ? { status: r.ch_status, ssl_status: r.ch_ssl_status, active: r.ch_status === 'active' && r.ch_ssl_status === 'active' } : null);

function configView(r: MtaStsRow) {
  return {
    enabled: r.enabled, mode: r.mode, state: r.state, via: r.via ?? 'cloudflare', policy_host: r.policy_host,
    mx_hosts: r.mx_hosts, mx_host_list: splitHosts(r.mx_hosts), policy_id: r.policy_id, max_age: r.max_age,
    policy_published_at: r.policy_published_at, mode_changed_at: r.mode_changed_at, left_enforce_at: r.left_enforce_at, last_checked_at: r.last_checked_at,
    last_error: r.last_error, notice: r.notice, notice_at: r.notice_at, created_at: r.created_at, updated_at: r.updated_at,
    domain_id: r.domain_id, mta_sts_record_id: r.mta_sts_record_id, tls_rpt_record_id: r.tls_rpt_record_id, cname_record_id: r.cname_record_id,
  };
}

const reportView = (r: { id: number; org_name: string; date_begin: number; date_end: number; total_success: number; total_failure: number; sts_success: number | null; sts_failure: number | null; sts_failure_types: string | null; created_at: number }) => {
  let types: string[] = [];
  try { const v = r.sts_failure_types ? JSON.parse(r.sts_failure_types) : []; if (Array.isArray(v)) types = v.filter((t): t is string => typeof t === 'string'); } catch { /* unknown */ }
  return {
    id: r.id, reporter: r.org_name, period_start: r.date_begin, period_end: r.date_end, received_at: r.created_at,
    successful_sessions: r.total_success, failed_sessions: r.total_failure,
    sts_successful_sessions: r.sts_success, sts_failed_sessions: r.sts_failure, failure_types: types,
  };
};

// ── GET ──────────────────────────────────────────────────────

/** Everything the MTA-STS page needs, in one read. Live DNS: the MX hosts only (and the records are read by `verify`). */
export async function mtaStsView(tenant: TenantContext, domain: DomainRow): Promise<Result> {
  const row = await tenant.scope.mtaSts.get(domain.id);
  const av = await availability(tenant, domain);
  const mx = await readMx(domain.domain);
  const now = nowSeconds();
  const strategy = row ? { kind: row.policy_host, cnameProxied: row.policy_host === 'worker_route' } : av.strategy ? { kind: av.strategy.kind, cnameProxied: av.strategy.cnameProxied } : null;
  const target = row || av.strategy ? await policyTarget(tenant, domain.domain, row ? { kind: row.policy_host, customHostname: row.policy_host === 'saas_hostname', route: true, cnameProxied: row.policy_host === 'worker_route' } : av.strategy!) : { target: null, problem: null };

  let reports: ReturnType<typeof reportView>[] = [];
  let summary: { total_success: number; total_failure: number; report_count: number; sts_success: number; sts_failure: number } | null = null;
  let enforce: (Readiness & { allowed: boolean }) | null = null;
  let disable: ReturnType<typeof disableRule> | null = null;
  if (row) {
    const since30 = now - 30 * 86400;
    const [recent, totals, evidence] = await Promise.all([
      tenant.scope.reports.tlsRecent(domain.id, since30, 20),
      tenant.scope.reports.tlsSummary(domain.id, since30),
      tenant.scope.reports.tlsEvidence(domain.id, now - EVIDENCE_WINDOW_SECONDS),
    ]);
    reports = recent.map(reportView);
    summary = {
      total_success: totals?.total_success ?? 0, total_failure: totals?.total_failure ?? 0, report_count: totals?.report_count ?? 0,
      sts_success: recent.reduce((n, r) => n + (r.sts_success ?? 0), 0), sts_failure: recent.reduce((n, r) => n + (r.sts_failure ?? 0), 0),
    };
    if (row.mode === 'testing') {
      const ready = enforceReadiness(row, evidence, mx.status === 'ok' ? mx.hosts : null, now);
      enforce = { ...ready, allowed: ready.ready };
    }
    disable = disableRule(row, now);
  }

  return {
    status: 200,
    body: {
      available: !!row || av.available,
      unavailable_reason: row ? 'none' : av.reason,
      unavailable_message: row ? null : av.message,
      via: row ? (row.via ?? 'cloudflare') : av.via,
      policy_host: row ? row.policy_host : av.strategy?.kind ?? null,
      mx_preview: mx,
      // Nothing to show or add when it cannot be turned on here.
      records: !row && !av.available ? [] : recordsFor(domain.domain, {
        target: target.target, proxied: strategy?.cnameProxied ?? false, address: tlsRptAddress(tenant), policyId: row?.policy_id ?? null, row, strategy: av.strategy,
      }),
      records_problem: target.problem,
      config: row ? configView(row) : null,
      policy_host_status: row ? { kind: row.policy_host, hostname: policyHostname(domain.domain), certificate: certificateOf(row), route: !!row.route_id } : null,
      summary,
      reports,
      enforce,
      disable,
      max_age: row?.max_age ?? DEFAULT_MAX_AGE,
    },
  };
}

// ── Enable ───────────────────────────────────────────────────

const TXT_V = (s: string) => s.replace(/^\s*"|"\s*$/g, '').trim();

/** What is already in the way at the names we are about to write, as one sentence naming it; null when the way is clear. Throws on a DNS failure. */
async function inTheWay(domain: string, resolver: Resolver): Promise<string | null> {
  const d = norm(domain);
  const [sts, rpt, cname, a, aaaa] = await Promise.all([
    resolver.txt(`_mta-sts.${d}`), resolver.txt(`_smtp._tls.${d}`),
    resolver.resolve(`mta-sts.${d}`, 'CNAME'), resolver.resolve(`mta-sts.${d}`, 'A'), resolver.resolve(`mta-sts.${d}`, 'AAAA'),
  ]);
  for (const r of [sts, rpt, cname, a, aaaa]) if (r.status === 'error') throw new Error(r.error ?? 'DNS lookup failed');
  if (sts.records.some((r) => /^\s*v=STSv1\b/i.test(TXT_V(r)))) return `_mta-sts.${d} already has a record (${TXT_V(sts.records.find((r) => /v=STSv1/i.test(r))!)}). Remove it before turning MTA-STS on here.`;
  if (rpt.records.some((r) => /^\s*v=TLSRPTv1\b/i.test(TXT_V(r)))) return `_smtp._tls.${d} already has a TLS reporting record (${TXT_V(rpt.records.find((r) => /v=TLSRPTv1/i.test(r))!)}). A domain can have only one: remove it or add our address to it by hand, then try again.`;
  const hasHost = cname.status === 'ok' || a.status === 'ok' || aaaa.status === 'ok';
  if (hasHost) return `mta-sts.${d} already exists in DNS. Remove it before turning MTA-STS on here.`;
  return null;
}

type Undo = () => Promise<void>;

async function rollback(undo: Undo[]): Promise<void> {
  for (const u of undo.reverse()) {
    try { await u(); } catch (e) { console.warn('[mta-sts] rollback step failed:', e instanceof Error ? e.message : e); }
  }
}

const auditOpts = (c: Ctx): MtaStsAuditOpts => ({ domain_name: c.domain.domain, actor_id: c.actor?.id, actor_email: c.actor?.email, actor_type: c.actor ? 'user' : 'system', ctx: c.ec });
const who = (c: Ctx) => ({ actor_id: c.actor?.id ?? null, actor_email: c.actor?.email ?? null, actor_type: (c.actor ? 'user' : 'system') as 'user' | 'system' });

/** Turn MTA-STS on, in testing. */
export async function enableMtaSts(c: Ctx): Promise<Result> {
  const { tenant, domain } = c;
  const existing = await tenant.scope.mtaSts.get(domain.id);
  if (existing?.enabled) return fail(409, 'MTA-STS already enabled for this domain');

  const av = await availability(tenant, domain);
  if (!av.available || !av.strategy || !av.via) return av.refusal ?? fail(403, 'MTA-STS is not available for this domain');
  const { strategy, via } = av;

  const address = tlsRptAddress(tenant);
  if (!address) return fail(400, REPORTS_DOMAIN_MISSING);
  const mx = await readMx(domain.domain);
  if (mx.status === 'error') return fail(502, `DNS lookup failed: ${mx.error}`);
  if (mx.status === 'none') return fail(422, `No MX records found for ${domain.domain}. Configure MX records before enabling MTA-STS.`);
  let clash: string | null;
  try { clash = await inTheWay(domain.domain, createResolver()); } catch (e) { return fail(502, `DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`); }
  if (clash) return fail(409, clash, { code: 'mta_sts_record_in_the_way' });
  const { target, problem } = await policyTarget(tenant, domain.domain, strategy);
  if (!target) return fail(502, problem ?? 'The policy host is not configured');
  if (existing) await tenant.scope.mtaSts.delete(domain.id); // a leftover row that is not enabled

  const undo: Undo[] = [];
  const written = { mta_sts_record_id: null as string | null, tls_rpt_record_id: null as string | null, cname_record_id: null as string | null };
  const audit = auditOpts(c);
  const now = nowSeconds();
  const policyId = generatePolicyId();
  try {
    let chId: string | null = null, chStatus: string | null = null, chSsl: string | null = null, routeId: string | null = null;
    if (strategy.customHostname || strategy.route) {
      const zone = await OperatorZone.open(tenant.env);
      if (strategy.customHostname) {
        const ch = await zone.createHostname(domain.domain);
        chId = ch.id; chStatus = ch.status; chSsl = ch.sslStatus;
        undo.push(() => zone.deleteHostname(ch.id, domain.domain).then(() => undefined));
      }
      const route = await zone.createRoute(domain.domain);
      routeId = route.id;
      undo.push(() => zone.deleteRoute(route.id, domain.domain).then(() => undefined));
    }
    const certActive = !strategy.customHostname || (chStatus === 'active' && chSsl === 'active');
    let state: MtaStsRow['state'] = 'waiting_records';
    let published: number | null = null;
    if (via === 'cloudflare') {
      undo.push(async () => { await deprovisionMtaSts(tenant, domain.domain, written); });
      written.cname_record_id = await createPolicyHostCname(tenant, domain.domain, { target, proxied: strategy.cnameProxied }, audit);
      written.tls_rpt_record_id = await createTlsRptRecord(tenant, domain.domain, address, audit);
      if (certActive) {
        written.mta_sts_record_id = await createPolicyIdRecord(tenant, domain.domain, policyId, audit);
        state = 'active'; published = now;
      } else state = 'waiting_certificate';
    }
    await tenant.scope.mtaSts.insert({
      domain_id: domain.id, mode: 'testing', mx_hosts: mx.hosts.join(','), policy_id: policyId,
      ...written, via, state, policy_host: strategy.kind, ch_id: chId, ch_status: chStatus, ch_ssl_status: chSsl, route_id: routeId,
      policy_published_at: published, mode_changed_at: now,
    });
    logAudit(tenant, { ...who(c), action: 'mta_sts.enable', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
      after_value: { mode: 'testing', mx_hosts: mx.hosts, policy_id: policyId, via, policy_host: strategy.kind, state } }, c.ec);
  } catch (e) {
    await rollback(undo);
    console.warn(`[mta-sts] enabling ${domain.domain} failed:`, e instanceof Error ? e.message : e);
    const f = cfFailureBody(e, 502);
    return { status: f.status, body: { ...f.body, error: `MTA-STS could not be turned on and nothing was changed: ${f.body.error}` } };
  }
  const view = await mtaStsView(tenant, domain);
  return { status: 201, body: { ok: true, mode: 'testing', mx_hosts: mx.hosts, ...view.body } };
}

// ── Verify and advance ───────────────────────────────────────

export type CheckState = 'ok' | 'pending' | 'missing' | 'wrong' | 'error' | 'not_applicable';
export interface Check { key: 'policy_host' | 'certificate' | 'tls_rpt' | 'policy_id'; label: string; state: CheckState; detail: string | null }

async function cnameCheck(resolver: Resolver, name: string, target: string | null, proxied: boolean): Promise<{ state: CheckState; detail: string | null }> {
  if (proxied) {
    const [a, aaaa] = await Promise.all([resolver.resolve(name, 'A'), resolver.resolve(name, 'AAAA')]);
    if (a.status === 'ok' || aaaa.status === 'ok') return { state: 'ok', detail: null };
    if (a.status === 'error' && aaaa.status === 'error') return { state: 'error', detail: a.error ?? 'DNS lookup failed' };
    return { state: 'missing', detail: `${name} does not resolve yet.` };
  }
  const r = await resolver.resolve(name, 'CNAME');
  if (r.status === 'error') return { state: 'error', detail: r.error ?? 'DNS lookup failed' };
  if (r.status === 'ok') {
    const got = r.answers.map((x) => norm(x.data));
    return got.includes(norm(target ?? '')) ? { state: 'ok', detail: null } : { state: 'wrong', detail: `${name} points at ${got.join(', ')}, not ${target}.` };
  }
  return { state: 'missing', detail: `There is no CNAME at ${name}.` };
}

/**
 * Read DNS and the policy host, and move setup forward when the evidence allows: the certificate becoming active publishes the `_mta-sts` TXT
 * (Cloudflare connection) or asks the person to (by hand); the TXT showing our id makes it active. Returns the checks and the stored row.
 */
export async function advanceMtaSts(c: Ctx, row: MtaStsRow, resolver: Resolver = createResolver()): Promise<{ row: MtaStsRow; checks: Check[] }> {
  const { tenant, domain } = c;
  const d = norm(domain.domain);
  const now = nowSeconds();
  const patch: Parameters<typeof tenant.scope.mtaSts.update>[1] = { last_checked_at: now };
  const checks: Check[] = [];
  const proxied = row.policy_host === 'worker_route';
  const address = tlsRptAddress(tenant);

  // Policy host: the CNAME, and (hosted custom hostname) the certificate.
  const target = row.policy_host === 'saas_hostname' ? policyHostConfig(tenant.env)?.target ?? null : null;
  const cname = await cnameCheck(resolver, `mta-sts.${d}`, target, proxied);
  checks.push({ key: 'policy_host', label: `mta-sts.${d} reaches the policy host`, ...cname });

  let certOk = true;
  if (row.policy_host === 'saas_hostname') {
    let state: CheckState = 'pending', detail: string | null = 'Cloudflare issues the certificate after the CNAME resolves; this takes a few minutes.';
    try {
      const zone = await OperatorZone.open(tenant.env);
      const ch = row.ch_id ? await zone.getHostname(row.ch_id) : await zone.findHostname(domain.domain);
      if (!ch) { state = 'missing'; detail = 'Cloudflare has no custom hostname for this name.'; certOk = false; }
      else {
        patch.ch_id = ch.id; patch.ch_status = ch.status; patch.ch_ssl_status = ch.sslStatus;
        certOk = ch.status === 'active' && ch.sslStatus === 'active';
        if (certOk) { state = 'ok'; detail = null; } else if (/fail|deleted|blocked|moved/.test(`${ch.status} ${ch.sslStatus}`)) { state = 'wrong'; detail = `Cloudflare reports the certificate as ${ch.sslStatus ?? ch.status}.`; }
      }
    } catch (e) { certOk = false; state = 'error'; detail = `The certificate status could not be read: ${e instanceof Error ? e.message : String(e)}`; }
    checks.push({ key: 'certificate', label: 'Certificate for the policy host', state, detail });
  } else checks.push({ key: 'certificate', label: 'Certificate for the policy host', state: 'not_applicable', detail: null });

  // TLS-RPT record.
  const rpt = await resolver.txt(`_smtp._tls.${d}`);
  let rptState: CheckState = 'missing', rptDetail: string | null = null;
  if (rpt.status === 'error') { rptState = 'error'; rptDetail = rpt.error ?? 'DNS lookup failed'; }
  else {
    const ours = rpt.records.some((r) => address && TXT_V(r).toLowerCase().includes(`rua=mailto:${address.toLowerCase()}`));
    const any = rpt.records.some((r) => /^\s*v=TLSRPTv1\b/i.test(TXT_V(r)));
    rptState = ours ? 'ok' : any ? 'wrong' : 'missing';
    if (rptState !== 'ok') rptDetail = any ? `_smtp._tls.${d} does not send reports to ${address}.` : `There is no TLS reporting record at _smtp._tls.${d}.`;
  }
  checks.push({ key: 'tls_rpt', label: 'TLS reports are sent to Ready Set Mail', state: rptState, detail: rptDetail });

  // Where setup stands, by evidence.
  const manual = row.via === 'manual';
  let state = row.state;
  const stage1 = cname.state === 'ok' && rptState === 'ok';
  if (manual && state === 'waiting_records' && stage1) state = row.policy_host === 'saas_hostname' && !certOk ? 'waiting_certificate' : 'waiting_txt';
  if (manual && state === 'waiting_certificate' && certOk) state = 'waiting_txt';
  if (!manual && state === 'waiting_certificate' && certOk) {
    try {
      const id = await createPolicyIdRecord(tenant, domain.domain, row.policy_id, auditOpts(c));
      patch.mta_sts_record_id = id;
      patch.policy_published_at = now;
      state = 'active';
    } catch (e) {
      patch.last_error = `The _mta-sts record could not be written: ${cfFailureBody(e, 502).body.error}`;
    }
  }

  // The policy id.
  const sts = await resolver.txt(`_mta-sts.${d}`);
  let stsState: CheckState = 'missing', stsDetail: string | null = null;
  if (sts.status === 'error') { stsState = 'error'; stsDetail = sts.error ?? 'DNS lookup failed'; }
  else {
    const rec = sts.records.map(TXT_V).find((r) => /^v=STSv1\b/i.test(r));
    const id = rec?.match(/(?:^|;)\s*id=([A-Za-z0-9]{1,32})/)?.[1];
    stsState = !rec ? 'missing' : id === row.policy_id ? 'ok' : 'wrong';
    if (stsState === 'wrong') stsDetail = `_mta-sts.${d} has id ${id ?? '(none)'}, not ${row.policy_id}.`;
    if (stsState === 'missing') {
      stsDetail = state === 'waiting_certificate' || state === 'waiting_records' ? 'Published last, once the certificate is active.' : `There is no _mta-sts record at _mta-sts.${d}.`;
      if (patch.mta_sts_record_id) { stsState = 'pending'; stsDetail = 'Just published: DNS can take a few minutes to show it.'; }
    }
  }
  checks.push({ key: 'policy_id', label: 'The policy id is published', state: stsState, detail: stsDetail });
  if (manual && state === 'waiting_txt' && stsState === 'ok') { state = 'active'; patch.policy_published_at = now; }
  if (manual && row.state === 'active' && stsState === 'ok' && row.policy_published_at === null) patch.policy_published_at = now;
  if (state !== row.state) patch.state = state;
  if (state === 'active' && !patch.last_error) patch.last_error = null;

  await tenant.scope.mtaSts.update(domain.id, patch);
  return { row: (await tenant.scope.mtaSts.get(domain.id)) ?? row, checks };
}

export async function verifyMtaSts(c: Ctx): Promise<Result> {
  const row = await c.tenant.scope.mtaSts.get(c.domain.id);
  if (!row?.enabled) return fail(404, 'MTA-STS not enabled for this domain');
  const { row: now, checks } = await advanceMtaSts(c, row);
  return { status: 200, body: { ok: true, state: now.state, checks, notice: now.notice, last_error: now.last_error } };
}

// ── Changing it ──────────────────────────────────────────────

/** Write the new id to the customer's record (when a connection owns it). The stored policy was changed first (RFC 8461 §8.1); on failure the caller reverts. */
async function publishId(c: Ctx, row: MtaStsRow, newId: string): Promise<void> {
  if (row.via === 'manual' || !row.mta_sts_record_id) return;
  await updateMtaStsTxtRecord(c.tenant, c.domain.domain, row.mta_sts_record_id, newId, { ...auditOpts(c), oldPolicyId: row.policy_id });
}

/**
 * After a change of policy: a connection publishes the new id now (once a record of ours exists; before that the id goes out with the first publish);
 * by hand, the person is asked to, and the row says it is not published.
 */
function publishedPatch(row: MtaStsRow, now: number) {
  if (row.via === 'manual') return { policy_published_at: null, ...(row.state === 'active' ? { state: 'waiting_txt' as const } : {}) };
  return row.mta_sts_record_id ? { policy_published_at: now } : {};
}

export async function changeMode(c: Ctx, mode: 'testing' | 'enforce'): Promise<Result> {
  const { tenant, domain } = c;
  const row = await tenant.scope.mtaSts.get(domain.id);
  if (!row?.enabled) return fail(404, 'MTA-STS not enabled for this domain');
  if (row.mode === mode) return { status: 200, body: { ok: true, mode, policy_id: row.policy_id, unchanged: true } };
  const now = nowSeconds();
  if (mode === 'enforce') {
    const [reports, mx] = await Promise.all([tenant.scope.reports.tlsEvidence(domain.id, now - EVIDENCE_WINDOW_SECONDS), readMx(domain.domain)]);
    const ready = enforceReadiness(row, reports, mx.status === 'ok' ? mx.hosts : null, now);
    if (!ready.ready) return fail(422, `MTA-STS cannot enforce yet: ${ready.reasons.join(' ')}`, { code: 'mta_sts_not_ready', reasons: ready.reasons });
  }
  const newId = nextPolicyId(row.policy_id);
  const leftEnforce = row.mode === 'enforce' && mode === 'testing';
  const pub = publishedPatch(row, now);
  // The stored policy first, then the record: a sender that sees the new id must find the new policy.
  await tenant.scope.mtaSts.updateMode(domain.id, mode, newId, now, { leftEnforce });
  await tenant.scope.mtaSts.update(domain.id, pub);
  try {
    await publishId(c, row, newId);
  } catch (e) {
    await tenant.scope.mtaSts.update(domain.id, {
      mode: row.mode, policy_id: row.policy_id, mode_changed_at: row.mode_changed_at, left_enforce_at: row.left_enforce_at,
      policy_published_at: row.policy_published_at, state: row.state,
    });
    const f = cfFailureBody(e, 502);
    return { status: f.status, body: { ...f.body, error: `The mode was not changed: ${f.body.error}` } };
  }
  logAudit(tenant, { ...who(c), action: 'mta_sts.mode_change', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
    before_value: { mode: row.mode, policy_id: row.policy_id }, after_value: { mode, policy_id: newId } }, c.ec);
  const manual = row.via === 'manual';
  return { status: 200, body: { ok: true, mode, policy_id: newId, publish: manual ? { name: `_mta-sts.${domain.domain}`, type: 'TXT', value: policyIdRecordValue(newId) } : null } };
}

export interface MxChange { changed: boolean; mx_hosts: string[]; policy_id: string | null; mode: 'testing' | 'enforce'; switchedToTesting: boolean }

/**
 * The domain's MX hosts changed: a new list means a new policy id (senders refetch only when it changes). When the list GREW while enforcing, the new hosts have no
 * TLS evidence, so the mode goes back to testing. Idempotent: the same list changes nothing. Never called with an empty or unread list.
 */
export async function applyMxChange(c: Ctx, row: MtaStsRow, live: readonly string[]): Promise<MxChange> {
  const { tenant, domain } = c;
  const stored = splitHosts(row.mx_hosts);
  const same = live.length === stored.length && [...live].sort().join() === [...stored].sort().join();
  if (same) return { changed: false, mx_hosts: stored, policy_id: null, mode: row.mode, switchedToTesting: false };
  const now = nowSeconds();
  const grew = live.some((h) => !stored.includes(h));
  const switched = row.mode === 'enforce' && grew;
  const mode = switched ? 'testing' : row.mode;
  const newId = nextPolicyId(row.policy_id);
  await tenant.scope.mtaSts.updateMxHosts(domain.id, live.join(','), newId);
  if (switched) await tenant.scope.mtaSts.updateMode(domain.id, 'testing', newId, now, { leftEnforce: true });
  await tenant.scope.mtaSts.update(domain.id, publishedPatch(row, now));
  try {
    await publishId(c, row, newId);
  } catch (e) {
    await tenant.scope.mtaSts.update(domain.id, {
      mx_hosts: row.mx_hosts, mode: row.mode, policy_id: row.policy_id, mode_changed_at: row.mode_changed_at, left_enforce_at: row.left_enforce_at,
      policy_published_at: row.policy_published_at, state: row.state,
    });
    throw e;
  }
  const manual = row.via === 'manual';
  const text = `Your MX hosts changed (now: ${live.join(', ')}); the policy lists them under a new id.`
    + (switched ? ' The mode went back to testing: the new hosts have no TLS reports yet.' : '')
    + (manual ? ` Publish the new id: _mta-sts.${domain.domain} TXT "${policyIdRecordValue(newId)}".` : '');
  await tenant.scope.mtaSts.update(domain.id, { notice: text, notice_at: now });
  logAudit(tenant, { ...who(c), action: 'mta_sts.mx_refresh', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
    before_value: { mx_hosts: stored, policy_id: row.policy_id, mode: row.mode }, after_value: { mx_hosts: [...live], policy_id: newId, mode } }, c.ec);
  return { changed: true, mx_hosts: [...live], policy_id: newId, mode, switchedToTesting: switched };
}

/** PATCH { refresh_mx }: read the MX hosts now and apply a change. */
export async function refreshMx(c: Ctx): Promise<Result> {
  const row = await c.tenant.scope.mtaSts.get(c.domain.id);
  if (!row?.enabled) return fail(404, 'MTA-STS not enabled for this domain');
  const mx = await readMx(c.domain.domain);
  if (mx.status === 'error') return fail(502, `DNS lookup failed: ${mx.error}`);
  if (mx.status === 'none') return fail(400, 'No MX records found');
  try {
    const r = await applyMxChange(c, row, mx.hosts);
    return { status: 200, body: { ok: true, mx_hosts: r.mx_hosts, policy_id: r.policy_id ?? row.policy_id, changed: r.changed, mode: r.mode } };
  } catch (e) {
    const f = cfFailureBody(e, 502);
    return { status: f.status, body: { ...f.body, error: `The MX hosts were not changed: ${f.body.error}` } };
  }
}

export async function dismissNotice(c: Ctx): Promise<Result> {
  const row = await c.tenant.scope.mtaSts.get(c.domain.id);
  if (!row?.enabled) return fail(404, 'MTA-STS not enabled for this domain');
  await c.tenant.scope.mtaSts.update(c.domain.id, { notice: null, notice_at: null });
  return { status: 200, body: { ok: true } };
}

// ── Turning it off ───────────────────────────────────────────

export interface Teardown { kept: KeptRecord[]; operator: 'none' | 'removed' | 'pending' }

/**
 * Remove exactly what Ready Set Mail made for this domain: the customer's records by id (a record the customer changed is kept, and said so), the
 * operator's custom hostname and Worker route by stored id (re-read first), and the row. Best effort and never throws: what could not be removed
 * is reported, and the daily job removes operator-side leftovers that no enabled row owns.
 */
export async function teardownMtaSts(c: Ctx, row: MtaStsRow): Promise<Teardown> {
  const { tenant, domain } = c;
  const ids = { mta_sts_record_id: row.mta_sts_record_id ?? null, tls_rpt_record_id: row.tls_rpt_record_id ?? null, cname_record_id: row.cname_record_id ?? null };
  const d = domain.domain;
  let removals: MtaStsRemoval[] = [];
  if (ids.mta_sts_record_id || ids.tls_rpt_record_id || ids.cname_record_id) {
    if (tenant.hasCloudflare()) {
      removals = await deprovisionMtaSts(tenant, d, ids).catch((e) => { console.warn(`[mta-sts] removing records of ${d}:`, e instanceof Error ? e.message : e); return []; });
    } else {
      const none: DnsRemoval = { state: 'kept', reason: 'no Cloudflare connection is available to delete it' };
      if (ids.mta_sts_record_id) removals.push({ id: ids.mta_sts_record_id, type: 'TXT', name: `_mta-sts.${d}`, removal: none });
      if (ids.tls_rpt_record_id) removals.push({ id: ids.tls_rpt_record_id, type: 'TXT', name: `_smtp._tls.${d}`, removal: none });
      if (ids.cname_record_id) removals.push({ id: ids.cname_record_id, type: 'CNAME', name: `mta-sts.${d}`, removal: none });
    }
  }
  const kept: KeptRecord[] = removals.flatMap((r) => (r.removal.state === 'kept' ? [{ type: r.type, name: r.name, reason: r.removal.reason }] : []));

  let operator: Teardown['operator'] = 'none';
  if (row.ch_id || row.route_id) {
    operator = 'removed';
    try {
      const zone = await OperatorZone.open(tenant.env);
      if (row.route_id) await zone.deleteRoute(row.route_id, d);
      if (row.ch_id) await zone.deleteHostname(row.ch_id, d);
    } catch (e) {
      operator = 'pending';
      console.warn(`[mta-sts] removing the policy host of ${d}:`, e instanceof Error ? e.message : e);
    }
  }

  const base = who(c);
  logAudit(tenant, {
    ...base, action: 'mta_sts.disable', resource_type: 'domain', resource_id: String(domain.id), resource_name: d,
    before_value: { mode: row.mode, mx_hosts: splitHosts(row.mx_hosts), policy_id: row.policy_id, policy_host: row.policy_host },
    ...(kept.length || operator === 'pending' ? { after_value: { kept, operator } } : {}),
  }, c.ec);
  const beforeOf = (r: MtaStsRemoval) => (r.type === 'CNAME' ? { type: 'CNAME', name: r.name } : r.name.startsWith('_mta-sts.')
    ? { type: 'TXT', name: r.name, content: policyIdRecordValue(row.policy_id) } : { type: 'TXT', name: r.name });
  for (const r of removals) {
    logAudit(tenant, { ...base, action: removalAction(r.removal), resource_type: 'dns_record', resource_id: r.id, resource_name: r.name, before_value: beforeOf(r),
      ...(r.removal.state === 'kept' ? { after_value: { kept: true, reason: r.removal.reason } } : {}) }, c.ec);
  }
  // The row goes even when a record was kept: it drives the policy file and the daily job, and a disabled feature serves neither. A kept record is the
  // customer's now; it is in the response and in its dns.kept audit entry.
  await tenant.scope.mtaSts.delete(domain.id);
  return { kept, operator };
}

/** DELETE: only in testing, and only once senders that fetched an enforce policy no longer hold it. */
export async function disableMtaSts(c: Ctx): Promise<Result> {
  const row = await c.tenant.scope.mtaSts.get(c.domain.id);
  if (!row) return { status: 204, body: {} };
  const rule = disableRule(row, nowSeconds());
  if (!rule.allowed) return fail(409, rule.reason!, { code: 'mta_sts_disable_blocked', after: rule.after });
  const t = await teardownMtaSts(c, row);
  return { status: 200, body: { ok: true, kept: t.kept, operator: t.operator, message: `Senders that already fetched the policy may keep it for up to ${maxAgeWords(row.max_age)}.` } };
}

/** The records of a removed or evicted domain, torn down without asking (the domain left: delete, eviction, a lapsed proof). Best effort. */
export async function retireMtaSts(c: Ctx): Promise<Teardown | null> {
  const row = await c.tenant.scope.mtaSts.get(c.domain.id);
  return row ? teardownMtaSts(c, row) : null;
}
