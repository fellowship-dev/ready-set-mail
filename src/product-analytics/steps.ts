// The product steps after sign-up, each called with one line from the server action that makes it true (docs/analytics.md): domains,
// ownership, Cloudflare, records, reports, the dashboard, teammates, agents and billing. Every function returns at once and does its
// reading (a marker, a count) in the background through captureLater: nothing here can slow down or fail the request it rides on.
//
// "First time" events (records live, first report, first dashboard view, an agent's first call) are made exactly-once by a marker row in
// the workspace's settings (identity.ts claimMarker): the call that inserts the marker sends the event, every later one finds it there.
import { workspaceLifecycle } from '@ready-set-mail/db';
import type { DmarcFacts, DomainRow, OrderRow } from '@ready-set-mail/db';
import type { TenantContext } from '../tenancy/context';
import type { BillingAuditAction } from '../billing/notify';
import { detectDnsHostFor } from '../domains/dns-host';
import { proofMethodOf, proofMethodOfVia, proofPathOf, type ProofSource, type VerifiedVia } from '../domains/ownership';
import { resolverFor } from '../dns/resolver';
import { capture, captureLater, captureMany, ev, type AnalyticsEnv, type Captured } from './capture';
import { AGENT_TOOLS, DNS_PROVIDERS, countBucket, daysBucket, issuesBucket, longWait, shortWait } from './events';
import { claimMarker, markerAt, markerCount, setMarker } from './identity';
import { noteRecordsLive } from '../lifecycle/email/milestones';

type Ctx = Pick<ExecutionContext, 'waitUntil'> | undefined;
const nowS = () => Math.floor(Date.now() / 1000);
const ws = (tenant: TenantContext) => ({ workspaceId: tenant.workspaceId });

/**
 * What the stored DNS read says needs fixing, 0 to 2: no SPF record; no DMARC record or one that only monitors (p=none). Null when the
 * domain was never read.
 */
export function verdictIssues(row: Pick<DomainRow, 'dns_checked_at' | 'spf_record' | 'dmarc_policy'> | null): number | null {
  if (!row || !row.dns_checked_at) return null;
  return (row.spf_record ? 0 : 1) + (row.dmarc_policy && row.dmarc_policy !== 'none' ? 0 : 1);
}

async function dnsProvider(tenant: TenantContext, domain: string): Promise<(typeof DNS_PROVIDERS)[number]> {
  const r = await detectDnsHostFor(domain, resolverFor(tenant.env));
  if (r.status === 'known' && r.provider && (DNS_PROVIDERS as readonly string[]).includes(r.provider.id)) return r.provider.id as (typeof DNS_PROVIDERS)[number];
  return r.status === 'mixed' ? 'mixed' : r.status === 'unknown' && r.nameservers.length > 0 ? 'other' : 'unknown';
}

const liveDomains = (tenant: TenantContext) => tenant.scope.domains.list().then((l) => l.length).catch(() => 0);

// ── Domains and ownership ────────────────────────────────────

/**
 * A request to add domains was accepted: `added` new domains or claims (0: it was all there already, nothing is counted). One name
 * (`domain`) also gets its DNS host and, when it was already read, the stored verdict.
 */
export function domainAdded(tenant: TenantContext, ctx: Ctx, p: { source: 'typed' | 'bulk' | 'cloudflare_import' | 'agent'; added: number; needsProof: boolean; domain?: string; claimId?: number }): void {
  if (p.added <= 0) return;
  captureLater(tenant.env, ctx, async () => {
    // A pending claim is counted once, however many times the same claim is answered again (admitDomain returns the same claim).
    if (p.claimId !== undefined && !(await claimMarker(tenant.db, tenant.workspaceId, `claim:${p.claimId}`))) return null;
    const row = p.domain ? await tenant.scope.domains.getByName(p.domain) : null;
    const provider = p.source === 'cloudflare_import' ? 'cloudflare' : p.domain ? await dnsProvider(tenant, p.domain).catch(() => 'unknown' as const) : 'unknown';
    return { subject: ws(tenant), events: [ev('Domain Added', {
      source: p.source, needs_proof: p.needsProof, added: countBucket(p.added), domains: countBucket(await liveDomains(tenant)),
      dns_provider: provider, verdict_issues: issuesBucket(p.added === 1 ? verdictIssues(row) : null),
    })] };
  });
}

/** One of the enrollment answers (src/domains/service.ts enrollDomain), as a Domain Added: a pending claim or a new domain; a repeat counts nothing. */
export function enrollmentAdded(tenant: TenantContext, ctx: Ctx, source: 'typed' | 'agent', domain: string, result: { pending?: boolean; resumed?: boolean; claim?: { id: number } }): void {
  if (result.resumed) return;
  domainAdded(tenant, ctx, { source, added: 1, needsProof: !!result.pending, domain, ...(result.pending && result.claim ? { claimId: result.claim.id } : {}) });
}

/**
 * A domain row was inserted with its ownership established (src/domains/service.ts commitVerifiedDomain, the wizard's base domain).
 * This is where `path` is decided for the setup funnels: how the ownership was proven (the Cloudflare zone, or by hand), whatever way
 * the domain was entered.
 */
export function ownershipVerified(tenant: TenantContext, ctx: Ctx, domain: string, via: VerifiedVia | string): void {
  captureLater(tenant.env, ctx, async () => {
    const claim = await tenant.db.prepare('SELECT created_at FROM domain_claims WHERE workspace_id = ?1 AND domain = ?2 ORDER BY id DESC LIMIT 1').bind(tenant.workspaceId, domain).first<{ created_at: number }>();
    const method = proofMethodOfVia(via);
    return { subject: ws(tenant), events: [ev('Ownership Verified', { path: proofPathOf(method), ...(method !== 'other' ? { method } : {}), wait: shortWait(claim ? nowS() - claim.created_at : null) })] };
  });
}

// ── Records ──────────────────────────────────────────────────

/** Apply was pressed (the plan's step, or the domain page's DMARC record): `changes` writes asked for. */
export function applyClicked(tenant: TenantContext, ctx: Ctx, step: 'dmarc' | 'reports_mailbox' | 'dmarc_record', changes: number): void {
  capture(tenant.env, ctx, ws(tenant), 'Apply Clicked', { path: 'cloudflare', step, changes: countBucket(changes) });
}

/**
 * Apply finished. `domainIds` were written to: their "last applied" time is kept so Records Live can say how long public DNS took.
 */
export function applyDone(tenant: TenantContext, ctx: Ctx, p: { step: 'dmarc' | 'reports_mailbox' | 'dmarc_record'; changes: number; failed: number; reports: 'connected' | 'refused' | 'none'; domainIds: number[] }): void {
  captureLater(tenant.env, ctx, async () => {
    if (p.changes - p.failed > 0) for (const id of new Set(p.domainIds)) await setMarker(tenant.db, tenant.workspaceId, `applied:${id}`);
    const result = p.changes === 0 ? 'nothing_to_do' : p.failed === 0 ? 'applied' : p.failed < p.changes ? 'partial' : 'failed';
    return { subject: ws(tenant), events: [ev('Apply Done', { path: 'cloudflare', step: p.step, result, changes: countBucket(p.changes), reports: p.reports })] };
  });
}

/** Whether a DMARC read sends reports to this domain's own report address (the rule recordDnsCheck stores as `dmarc_rua`). */
export function sendsReportsHere(ruaAddress: string | null | undefined, dmarc: Pick<DmarcFacts, 'p' | 'rua'> | undefined): boolean {
  const ours = ruaAddress?.trim().toLowerCase();
  if (!ours || !dmarc || dmarc.p === undefined) return false;
  return (dmarc.rua ?? []).some((a) => a.trim().toLowerCase() === ours);
}

/** Who wrote the records of a domain: our Apply (its `applied:<id>` marker exists) or the person, by hand. Not the setup path. */
const recordsBy = (applied: number | null): 'apply' | 'hand' => (applied === null ? 'hand' : 'apply');

/**
 * The records of a domain were observed live (its DMARC record sends reports to its report address): counted once per domain, by
 * whichever read sees it first. Costs one statement (the marker) per call; the event's own reads run only the first time.
 */
export function recordsSeenLive(tenant: TenantContext, ctx: Ctx, domain: Pick<DomainRow, 'id'> & ProofSource, seenBy: 'setup' | 'domain_page' | 'daily'): void {
  noteRecordsLive(tenant, ctx, domain.id, seenBy); // the lifecycle emails' own record of the first sight, whether or not PostHog is on (src/lifecycle/email/milestones.ts)
  captureLater(tenant.env, ctx, async () => {
    if (!(await claimMarker(tenant.db, tenant.workspaceId, `live:${domain.id}`))) return null;
    const [workspace, applied, live] = await Promise.all([
      workspaceLifecycle(tenant.db).get(tenant.workspaceId), markerAt(tenant.db, tenant.workspaceId, `applied:${domain.id}`), markerCount(tenant.db, tenant.workspaceId, 'live:'),
    ]);
    const now = nowS();
    const method = proofMethodOf(domain);
    return { subject: ws(tenant), events: [ev('Records Live', {
      path: proofPathOf(method), records_by: recordsBy(applied), seen_by: seenBy, method, since_signup: longWait(workspace ? now - workspace.created_at : null),
      since_apply: shortWait(applied === null ? null : now - applied), domains_live: countBucket(live),
    })] };
  });
}

/**
 * A DNS read of a domain was stored (domains.recordDnsCheck), by a caller that has the domain's row and the read: no query at all
 * unless the read shows the records live, then recordsSeenLive. The daily job passes the row it already loaded.
 */
export function dnsChecked(tenant: TenantContext, ctx: Ctx, domain: Pick<DomainRow, 'id' | 'rua_address'> & ProofSource, dmarc: Pick<DmarcFacts, 'p' | 'rua'> | undefined, seenBy: 'setup' | 'daily'): void {
  try {
    if (sendsReportsHere(domain.rua_address, dmarc)) recordsSeenLive(tenant, ctx, domain, seenBy);
  } catch { /* never affects the read */ }
}

/** A DNS read was stored by a caller without the row (the first check after setup): reads the stored result in the background. */
export function dnsCheckedById(tenant: TenantContext, ctx: Ctx, domainId: number): void {
  captureLater(tenant.env, ctx, async () => {
    const row = await tenant.scope.domains.getById(domainId);
    if (row && row.dmarc_rua === 1) recordsSeenLive(tenant, ctx, row, 'setup');
    return null;
  });
}

// ── Reports ──────────────────────────────────────────────────

/** An aggregate report was stored for a domain: the first one is counted, with how long after its records went live. */
export function reportStored(tenant: TenantContext, ctx: Ctx, domainId: number): void {
  captureLater(tenant.env, ctx, async () => {
    if (!(await claimMarker(tenant.db, tenant.workspaceId, `first_report:${domainId}`))) return null;
    const [live, applied, row] = await Promise.all([markerAt(tenant.db, tenant.workspaceId, `live:${domainId}`), markerAt(tenant.db, tenant.workspaceId, `applied:${domainId}`), tenant.scope.domains.getById(domainId)]);
    return { subject: ws(tenant), events: [ev('First Report Received', { ...(row ? { path: proofPathOf(proofMethodOf(row)) } : {}), records_by: recordsBy(applied), since_live: longWait(live === null ? null : nowS() - live) })] };
  });
}

/** How long after records go live a domain with no report yet counts as "no report after 3 days". */
export const NO_REPORT_AFTER_SECONDS = 3 * 86400;

/** Daily (src/cron.ts, 11:00 UTC): domains live for 3 days with no report yet, each counted once, as one event per workspace. */
export function dailyAnalytics(tenant: TenantContext, ctx: Ctx): void {
  captureLater(tenant.env, ctx, async () => {
    const cutoff = nowS() - NO_REPORT_AFTER_SECONDS;
    const { results } = await tenant.db.prepare("SELECT substr(key, 16) AS id FROM settings WHERE workspace_id = ?1 AND substr(key, 1, 15) = 'analytics:live:' AND CAST(value AS INTEGER) <= ?2")
      .bind(tenant.workspaceId, cutoff).all<{ id: string }>();
    let waiting = 0;
    for (const { id } of results ?? []) {
      if (!/^\d+$/.test(id) || (await markerAt(tenant.db, tenant.workspaceId, `first_report:${id}`)) !== null) continue;
      if (await claimMarker(tenant.db, tenant.workspaceId, `no_report:${id}`)) waiting++;
    }
    return waiting ? { subject: ws(tenant), events: [ev('No Report After 3 Days', { domains_waiting: countBucket(waiting) })] } : null;
  });
}

// ── Dashboard ────────────────────────────────────────────────

/** GET /api/me from the dashboard: its first view (with what the person found), and at most one "active" per workspace and UTC day. */
export function dashboardViewed(tenant: TenantContext, ctx: Ctx, role: string | undefined): void {
  const r = role === 'owner' || role === 'admin' ? role : 'member';
  captureLater(tenant.env, ctx, async () => {
    const db = tenant.db;
    const events: Captured[] = [];
    const counts = await db.prepare("SELECT (SELECT COUNT(*) FROM domains WHERE workspace_id = ?1 AND evicted_at IS NULL) AS d, (SELECT COUNT(*) FROM domain_claims WHERE workspace_id = ?1 AND status = 'pending' AND settled_at IS NULL) AS c").bind(tenant.workspaceId).first<{ d: number; c: number }>();
    const domains = counts?.d ?? 0;
    if (await claimMarker(db, tenant.workspaceId, 'first_view')) {
      const live = await markerCount(db, tenant.workspaceId, 'live:');
      events.push(ev('Dashboard First Viewed', { role: r, state: live > 0 ? 'records_live' : domains > 0 ? 'domains' : (counts?.c ?? 0) > 0 ? 'proof_pending' : 'no_domains' }));
    }
    // One row per workspace: the last UTC day it was counted active, moved forward by one conditional statement.
    const day = String(Math.floor(Date.now() / 86_400_000));
    const key = 'analytics:active_day';
    const moved = await db.prepare('INSERT INTO settings (workspace_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch() WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)')
      .bind(tenant.workspaceId, key, day).run();
    if ((moved.meta.changes ?? 0) > 0) events.push(ev('Workspace Active', { role: r, domains: countBucket(domains) }));
    return { subject: ws(tenant), events };
  });
}

// ── Free email check from a signed-in dashboard ─────────────

// These routes are open to anyone (the website's check uses them too): only a signed-in caller's check is counted, and who is
// calling is resolved in the background, so an anonymous request does no extra work before its answer.

/** POST /api/check-sessions answered with a test address. */
export function emailCheckStartedLater(env: AnalyticsEnv, ctx: Ctx, tenantFor: () => Promise<TenantContext>): void {
  captureLater(env, ctx, async () => {
    const tenant = await tenantFor();
    return tenant.userId ? { subject: ws(tenant), events: [ev('Email Check Started')] } : null;
  });
}

/** GET /api/check-sessions/:token found the result: counted once per check session. */
export function emailCheckDoneLater(env: AnalyticsEnv, ctx: Ctx, tenantFor: () => Promise<TenantContext>, sessionToken: string, result: string | null | undefined): void {
  captureLater(env, ctx, async () => {
    const tenant = await tenantFor();
    if (!tenant.userId) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionToken)));
    const key = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!(await claimMarker(tenant.db, tenant.workspaceId, `check:${key}`))) return null;
    const r = result === 'protected' || result === 'at_risk' || result === 'exposed' ? result : 'other';
    return { subject: ws(tenant), events: [ev('Email Check Done', { result: r })] };
  });
}

// ── Teammates and workspaces ─────────────────────────────────

export function inviteSent(tenant: TenantContext, ctx: Ctx, role: string): void {
  capture(tenant.env, ctx, ws(tenant), 'Invite Sent', { role: role === 'admin' ? 'admin' : 'member' });
}

export function workspaceAdded(env: AnalyticsEnv, ctx: Ctx, workspaceId: string): void {
  capture(env, ctx, { workspaceId }, 'Workspace Created', { source: 'added' });
}

// ── Cloudflare ───────────────────────────────────────────────

/** POST /api/cloudflare/oauth/start: the OAuth way to connect Cloudflare begins. */
export function cloudflareConnectStarted(tenant: TenantContext, ctx: Ctx): void {
  capture(tenant.env, ctx, ws(tenant), 'Cloudflare Connect Started', { path: 'cloudflare', method: 'oauth' });
}

export function cloudflareConnectReturned(tenant: TenantContext, ctx: Ctx, method: 'oauth' | 'token', result: 'connected' | 'denied' | 'failed', connection?: { zones: unknown[]; accounts: unknown[] }): void {
  capture(tenant.env, ctx, ws(tenant), 'Cloudflare Connect Returned', {
    path: 'cloudflare', method, result, ...(connection ? { zones: countBucket(connection.zones.length), accounts: countBucket(connection.accounts.length) } : {}),
  });
}

/**
 * A pasted Cloudflare token connected (POST /api/cloudflare/connections): the start and the return of the token way, in one batch and
 * in that order, so the setup funnels count this path like the OAuth one.
 */
export function cloudflareTokenConnected(tenant: TenantContext, ctx: Ctx, connection: { zones: unknown[]; accounts: unknown[] }): void {
  captureMany(tenant.env, ctx, ws(tenant), [
    ev('Cloudflare Connect Started', { path: 'cloudflare', method: 'token' }),
    ev('Cloudflare Connect Returned', { path: 'cloudflare', method: 'token', result: 'connected', zones: countBucket(connection.zones.length), accounts: countBucket(connection.accounts.length) }),
  ]);
}

// ── Agents ───────────────────────────────────────────────────

export function agentAuthorized(env: AnalyticsEnv, ctx: Ctx, workspaceId: string, p: { actions: number; domains: number; days: number }): void {
  capture(env, ctx, { workspaceId }, 'Agent Authorized', { actions: countBucket(p.actions), domains: countBucket(p.domains), days: daysBucket(p.days) });
}

/** A tool call that succeeded: the first one of each agent connection is counted, in the workspace its consent named first. */
export function agentToolCalled(env: AnalyticsEnv & { DB?: D1Database }, ctx: Ctx, principalId: string, tool: string, resolveWorkspace: () => Promise<string | null>): void {
  if (!(AGENT_TOOLS as readonly string[]).includes(tool)) return;
  captureLater(env, ctx, async () => {
    const workspaceId = await resolveWorkspace();
    if (!workspaceId || !env.DB || !(await claimMarker(env.DB, workspaceId, `agent:${principalId}`))) return null;
    return { subject: { workspaceId }, events: [ev('Agent First Call', { tool: tool as (typeof AGENT_TOOLS)[number] })] };
  });
}

// ── Billing ──────────────────────────────────────────────────

/** The order audit trail (src/billing/notify.ts auditOrder) as product events. The price goes as a tier, never an amount. */
export function orderEvent(env: AnalyticsEnv, ctx: Ctx, order: Pick<OrderRow, 'workspace_id'> & Partial<Pick<OrderRow, 'amount' | 'amount_paid' | 'paid_at'>>, action: BillingAuditAction): void {
  const subject = { workspaceId: order.workspace_id };
  const offer = 'fix_one_domain' as const;
  switch (action) {
    case 'billing.card_session_started': return capture(env, ctx, subject, 'Card Setup Started');
    case 'billing.card_added': return capture(env, ctx, subject, 'Card Setup Completed');
    case 'billing.order_created': return capture(env, ctx, subject, 'Fix Order Created', { offer, price_tier: 'list' });
    case 'billing.order_paid': return capture(env, ctx, subject, 'Fix Order Paid', { offer, price_tier: typeof order.amount_paid === 'number' && typeof order.amount === 'number' && order.amount_paid < order.amount ? 'reduced' : 'list' });
    case 'billing.order_failed': return capture(env, ctx, subject, 'Fix Order Failed', { offer, reason: 'failed' });
    case 'billing.order_canceled': return capture(env, ctx, subject, 'Fix Order Failed', { offer, reason: 'canceled' });
    case 'billing.order_refunded': return capture(env, ctx, subject, 'Fix Order Refunded', { offer });
    case 'billing.order_done': return capture(env, ctx, subject, 'Fix Order Delivered', { offer, since_paid: longWait(order.paid_at ? nowS() - order.paid_at : null) });
    case 'billing.order_started': return;
  }
}

/** The domain page loaded the offer (GET /api/billing/domains/:id) and it can be bought. */
export function offerViewed(env: AnalyticsEnv, ctx: Ctx, workspaceId: string, hasCard: boolean): void {
  capture(env, ctx, { workspaceId }, 'Fix Offer Viewed', { offer: 'fix_one_domain', has_card: hasCard });
}
