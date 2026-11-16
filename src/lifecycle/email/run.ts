// The lifecycle emails' job: one call per workspace from the daily 11:00 UTC branch of src/cron.ts (hosted only), plus the real-time first-report send.
//
// State, not timers: every email below is sent because a fact stored in the database became true (a milestone row, a report, a week's totals),
// or verifiably did not happen by a deadline measured from one. Nothing here reads the clock to decide WHETHER to send; the clock only says which
// week just ended and how old a fact is.
//
// Sending is claim-first (packages/db lifecycle_sends, state.ts): the run whose INSERT OR IGNORE wrote the row is the only one that sends, so
// running the job twice, or two jobs at once, never sends twice. A claim that sent nothing for a reason that may pass (no provider, a
// configuration error, a suppressed address) is given back; one whose outcome is unknown stays and is never retried.

import { workspaceLifecycle, type DomainRow, type MilestoneRow, type PreferenceRow, type RecipientRow, type SendRow, type WeekSourceRow } from '@ready-set-mail/db';
import { dmarcSteps, policyInForce, type DmarcStep, type InForce, type Policy, type StoredDmarc } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { lookupDmarc, type DmarcLookup } from '@ready-set-mail/dns-checks';
import { organizationalDomain } from '@ready-set-mail/dns-checks/org-domain';
import { appUrl } from '../../billing/paths';
import { billingEnabled, priceLookupKey } from '../../billing/config';
import { resolverFor } from '../../dns/resolver';
import { dmarcFactsFromLookup } from '../../email/dns-snapshot';
import { postalAddress, publicBaseUrl } from '../../funnel/config';
import { emailCheckAvailable, hostedEnabled } from '../../hosted/config';
import type { BoundEnv } from '../../index';
import { accountSender } from '../../mail/compliance';
import type { Mailer } from '../../mail/mailer';
import { ownerMailer } from '../../mail/mailer';
import { capture } from '../../product-analytics/capture';
import { recordsSeenLive, sendsReportsHere } from '../../product-analytics/steps';
import { provenDomainIds } from '../../domains/ownership';
import { getMode } from '../../tenancy/mode';
import type { TenantContext } from '../../tenancy/context';
import {
  allPassed, failingSources, noTotals, quietWeek, sourceStats, summarise, tipFixSources,
  type SourceStat, type SummaryDomain, type Totals,
} from './analysis';
import * as copy from './copy';
import type { Mail, Footer, Who } from './copy';
import {
  FIRST_REPORT_CATCHUP_SECONDS, LIVE_EMAIL_MAX_AGE_SECONDS, LIVE_WATCH_SECONDS, MAX_LIFECYCLE_SENDS_PER_RUN, MAX_LIVE_READS_PER_RUN, MAX_PER_RECIPIENT_PER_RUN,
  NO_REPORT_AFTER_SECONDS, stopped, TIP_INTERVAL_SECONDS, type LifecycleKind,
} from './kinds';
import { markRecordsLive } from './milestones';
import { cachedOfferPrice } from './offer';
import { milestoneRecipients, preferenceOffUrl, preferenceRecipients, type Recipient } from './preferences';
import { deliver } from './send';
import { isoWeekId, lastCompleteWeek, WEEK } from './time';

// ── The budget of one scheduled invocation ───────────────────

export interface Budget {
  /** Emails left for the whole invocation, over every workspace. */
  sends: number;
  /** Emails each person has had in this invocation. */
  byUser: Map<string, number>;
  /** DNS reads left: watching domains for their records going live, the no-report checks, and the live check before a tip. */
  liveReads: number;
  noReportReads: number;
  tipReads: number;
}
export const newBudget = (): Budget => ({ sends: MAX_LIFECYCLE_SENDS_PER_RUN, byUser: new Map(), liveReads: MAX_LIVE_READS_PER_RUN, noReportReads: MAX_LIVE_READS_PER_RUN, tipReads: MAX_LIVE_READS_PER_RUN });

export interface LifecycleDeps {
  /** Milliseconds; default Date.now. */
  now?: () => number;
  /** Default: the Worker's send_email binding (src/mail/mailer.ts `ownerMailer`), like the other owner-facing mail. */
  mailer?: Mailer | null;
  /** Default: `accountSender` (src/mail/compliance.ts): the platform sender; on self-host the workspace's own first. */
  from?: string;
  /** Default: a live DNS-over-HTTPS read. */
  readDmarc?: (domain: string) => Promise<DmarcLookup>;
}

type Ctx = Pick<ExecutionContext, 'waitUntil'> | undefined;
type Scope = TenantContext['scope']['lifecycleEmail'];

interface W {
  tenant: TenantContext;
  env: BoundEnv;
  ctx: Ctx;
  budget: Budget;
  deps: LifecycleDeps;
  now: number;
  q: Scope;
  base: string | null;
  requireVerified: boolean;
  workspaceName: string;
  mailer: Mailer | null;
  from: string | undefined;
  domains: DomainRow[];
  people: RecipientRow[];
  prefs: PreferenceRow[];
  sends: SendRow[];
  adders: Map<number, Set<string>>;
  milestones: Map<number, MilestoneRow>;
}

const log = (what: string, detail: string) => console.log(`[lifecycle] ${what}: ${detail}`);

// ── Sending one email ────────────────────────────────────────

const hasClaim = (w: W, userId: string, domainId: number, kind: LifecycleKind, period: string) =>
  w.sends.some((s) => s.user_id === userId && s.domain_id === domainId && s.kind === kind && s.period === period);
const tipsSince = (w: W, userId: string) => w.sends.filter((s) => s.user_id === userId && s.kind.startsWith('tip_') && s.created_at > w.now - TIP_INTERVAL_SECONDS).length;
const budgetLeft = (w: W, userId: string) => w.budget.sends > 0 && (w.budget.byUser.get(userId) ?? 0) < MAX_PER_RECIPIENT_PER_RUN;

interface Attempt {
  kind: LifecycleKind;
  to: Recipient;
  /** The claims this email covers (one per domain; `domainId` 0 for an email about the workspace). */
  claims: Array<{ domainId: number; period: string }>;
  /** Builds the email for the claims that were won. */
  build: (won: number[]) => Mail;
  /** The preference link: present for summary and tips (non-transactional). */
  offUrl?: string;
}

/** Claim, send, settle. True when an email went out. Never throws. */
async function attempt(w: W, a: Attempt): Promise<boolean> {
  if (stopped(w.env, a.kind) || !budgetLeft(w, a.to.userId)) return false;
  const won: number[] = [];
  const key = (domainId: number, period: string) => ({ userId: a.to.userId, domainId, kind: a.kind, period });
  try {
    for (const c of a.claims) if (await w.q.sends.claim(key(c.domainId, c.period), w.now)) { won.push(c.domainId); w.sends.push({ user_id: a.to.userId, domain_id: c.domainId, kind: a.kind, period: c.period, state: 'claimed', created_at: w.now }); }
  } catch (e) {
    console.error('[lifecycle] claim failed:', e instanceof Error ? e.name : 'error');
    return false;
  }
  if (won.length === 0) return false;
  const mine = a.claims.filter((c) => won.includes(c.domainId));
  const giveBack = async () => {
    for (const c of mine) { await w.q.sends.release(key(c.domainId, c.period)).catch(() => undefined); w.sends = w.sends.filter((s) => !(s.user_id === a.to.userId && s.domain_id === c.domainId && s.kind === a.kind && s.period === c.period)); }
  };
  let out;
  try {
    const mail = copy.render(a.build(won));
    out = await deliver(w.env, w.mailer, w.from, a.to.email, mail, { offUrl: a.offUrl, idempotencyKey: `${w.tenant.workspaceId}:${a.to.userId}:${a.kind}:${mine.map((c) => `${c.domainId}.${c.period}`).join(',')}` });
  } catch (e) {
    console.error(`[lifecycle] ${a.kind} build failed:`, e instanceof Error ? `${e.name}: ${e.message}` : 'error');
    await giveBack();
    return false;
  }
  if (out.state === 'release') { log('not sent', `${a.kind}, ${out.why ?? 'retry later'}`); await giveBack(); return false; }
  for (const c of mine) await w.q.sends.settle(key(c.domainId, c.period), out.state).catch(() => undefined);
  w.sends = w.sends.map((s) => (s.user_id === a.to.userId && s.kind === a.kind && mine.some((c) => c.domainId === s.domain_id && c.period === s.period) ? { ...s, state: out.state as 'sent' | 'failed' } : s));
  w.budget.sends--;
  w.budget.byUser.set(a.to.userId, (w.budget.byUser.get(a.to.userId) ?? 0) + 1);
  if (out.state === 'sent') capture(w.env, w.ctx, { workspaceId: w.tenant.workspaceId }, 'Lifecycle Email Sent', { kind: a.kind });
  else log('outcome unknown, not retried', a.kind);
  return out.state === 'sent';
}

// ── Footers ──────────────────────────────────────────────────

const roleWords = (r: Recipient['role']) => (r === 'owner' ? 'the owner' : 'an admin');
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function milestoneFooter(w: W, to: Recipient, domains: string[], added: boolean): Footer {
  const where = w.workspaceName;
  return {
    why: added ? `You get this because you added ${list(domains)} to ${where} on Ready Set Mail.` : `You get this because ${list(domains)} ${domains.length === 1 ? 'was' : 'were'} added to ${where}, where you are ${roleWords(to.role)}, on Ready Set Mail.`,
    settingsUrl: w.base ? appUrl(w.base, w.tenant.workspaceId, '/settings') : null,
  };
}

const who = (to: Recipient, footer: Footer): Who => ({ name: to.name, footer });
const domainLink = (w: W, domains: DomainRow[]) => (!w.base ? null : domains.length === 1 ? appUrl(w.base!, w.tenant.workspaceId, `/domains/${domains[0].id}`) : appUrl(w.base!, w.tenant.workspaceId, '/'));

// ── Milestone emails: records live, first report, no reports ─

interface Item<T> { domain: DomainRow; data: T }

/** One email per recipient covering every item they are due: claims are per domain, so a domain is never mailed twice. */
async function milestone<T>(w: W, kind: 'records_live' | 'first_report' | 'no_reports', items: Item<T>[], make: (who: Who, items: Item<T>[], url: string | null) => Mail): Promise<void> {
  // Every milestone but the first report is hosted only, where the public origin is always set; a self-host first report goes without a button.
  if ((!w.base && kind !== 'first_report') || items.length === 0) return;
  for (const to of new Map(items.flatMap((i) => milestoneRecipients(w.people, w.adders.get(i.domain.id) ?? new Set(), w.requireVerified)).map((r) => [r.userId, r])).values()) {
    const mine = items.filter((i) => milestoneRecipients(w.people, w.adders.get(i.domain.id) ?? new Set(), w.requireVerified).some((r) => r.userId === to.userId) && !hasClaim(w, to.userId, i.domain.id, kind, 'once'));
    if (mine.length === 0) continue;
    const added = mine.every((i) => w.adders.get(i.domain.id)?.has(to.userId));
    await attempt(w, {
      kind, to, claims: mine.map((i) => ({ domainId: i.domain.id, period: 'once' })),
      build: (won) => {
        const sent = mine.filter((i) => won.includes(i.domain.id));
        return make(who(to, milestoneFooter(w, to, sent.map((i) => i.domain.domain), added)), sent, domainLink(w, sent.map((i) => i.domain)));
      },
    });
  }
}

// b. records live ------------------------------------------------

const readDmarc = (w: W, domain: string): Promise<DmarcLookup> => (w.deps.readDmarc ?? ((d: string) => lookupDmarc(resolverFor(w.env), d)))(domain);

/** Look at the domains that are waiting to be seen live (connected, added within 30 days, no milestone yet): at most MAX_LIVE_READS_PER_RUN reads per run. */
async function watchForLive(w: W): Promise<void> {
  const waiting = w.domains.filter((d) => !w.milestones.has(d.id) && w.now - d.created_at <= LIVE_WATCH_SECONDS).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  for (const d of waiting) {
    if (w.budget.liveReads <= 0) break;
    w.budget.liveReads--;
    let facts;
    try { facts = dmarcFactsFromLookup(await readDmarc(w, d.domain)); } catch { continue; }
    if (!facts || !sendsReportsHere(d.rua_address, facts)) continue;
    if (await markRecordsLive(w.tenant, d.id, 'job', w.now)) recordsSeenLive(w.tenant, w.ctx, d, 'daily'); // the analytics event, once, like the daily read it replaces while that job is held
    w.milestones.set(d.id, { domain_id: d.id, records_live_at: w.now, live_seen_by: 'job' });
  }
}

async function sendRecordsLive(w: W): Promise<void> {
  const fresh = w.domains.filter((d) => {
    const m = w.milestones.get(d.id);
    return m?.live_seen_by === 'job' && m.records_live_at !== null && w.now - m.records_live_at <= LIVE_EMAIL_MAX_AGE_SECONDS;
  });
  const items: Item<{ seenAt: number }>[] = [];
  for (const d of fresh) {
    const due = milestoneRecipients(w.people, w.adders.get(d.id) ?? new Set(), w.requireVerified).some((r) => !hasClaim(w, r.userId, d.id, 'records_live', 'once'));
    if (!due) continue;
    // News only while no report has arrived: a domain that was already receiving them when it was first seen has nothing to wait for.
    const stored = await w.q.reports.storedSince(d.id, 0);
    if (stored.counted || stored.uncounted) continue;
    items.push({ domain: d, data: { seenAt: w.milestones.get(d.id)!.records_live_at! } });
  }
  await milestone(w, 'records_live', items, (who, sent, url) => copy.recordsLive({ ...who, items: sent.map((i) => ({ domain: i.domain.domain, seenAt: i.data.seenAt })), domainUrl: url! }));
}

// c. first report -----------------------------------------------

async function firstReportData(w: W, d: DomainRow, reportId: number): Promise<copy.FirstReportData | null> {
  const report = await w.q.reports.byId(reportId);
  if (!report || report.domain_id !== d.id) return null;
  const stats = sourceStats(await w.q.reports.reportSources(reportId), report.fail_count);
  return {
    reporter: report.reporter_known_as || report.org_name, begin: report.date_begin, end: report.date_end,
    total: report.total_count, passed: report.pass_count, sources: stats.length, failing: failingSources(stats)[0] ?? null, policy: d.dmarc_policy,
  };
}

async function sendFirstReports(w: W, only?: { domainId: number; reportId: number }): Promise<void> {
  const found = only ? [{ domain_id: only.domainId, report_id: only.reportId }] : await w.q.reports.firstCountedSince(w.now - FIRST_REPORT_CATCHUP_SECONDS);
  const items: Item<copy.FirstReportData>[] = [];
  for (const f of found) {
    const d = w.domains.find((x) => x.id === f.domain_id);
    if (!d) continue;
    if (!milestoneRecipients(w.people, w.adders.get(d.id) ?? new Set(), w.requireVerified).some((r) => !hasClaim(w, r.userId, d.id, 'first_report', 'once'))) continue;
    const data = await firstReportData(w, d, f.report_id);
    if (data) items.push({ domain: d, data });
  }
  await milestone(w, 'first_report', items, (who, sent, url) => copy.firstReport({ ...who, items: sent.map((i) => ({ domain: i.domain.domain, data: i.data })), domainUrl: url }));
}

// d. no reports yet ---------------------------------------------

async function sendNoReports(w: W): Promise<void> {
  const items: Item<{ liveAt: number; check: copy.LiveCheck }>[] = [];
  for (const d of w.domains) {
    const m = w.milestones.get(d.id);
    if (!m?.records_live_at || w.now - m.records_live_at < NO_REPORT_AFTER_SECONDS || w.now - m.records_live_at > LIVE_WATCH_SECONDS) continue;
    if (!milestoneRecipients(w.people, w.adders.get(d.id) ?? new Set(), w.requireVerified).some((r) => !hasClaim(w, r.userId, d.id, 'no_reports', 'once'))) continue;
    // Any report ever stored, not only since the records were seen: the job can see a domain live long after its first report arrived.
    const stored = await w.q.reports.storedSince(d.id, 0);
    if (stored.counted || stored.uncounted) {
      // Reports are arriving, only some are not counted: the domain is not silent, so this email would not be true.
      if (!stored.counted) log('no-report email skipped', `domain ${d.id} receives reports that are not counted`);
      continue;
    }
    if (w.budget.noReportReads <= 0) break;
    w.budget.noReportReads--;
    let lookup: DmarcLookup | null = null;
    try { lookup = await readDmarc(w, d.domain); } catch { lookup = null; }
    const facts = lookup ? dmarcFactsFromLookup(lookup) : undefined;
    const check: copy.LiveCheck = !facts ? { outcome: 'failed' } : sendsReportsHere(d.rua_address, facts) ? { outcome: 'names_us' } : { outcome: 'does_not', record: lookup?.record?.raw ?? null, address: d.rua_address };
    items.push({ domain: d, data: { liveAt: m.records_live_at, check } });
  }
  await milestone(w, 'no_reports', items, (who, sent, url) => copy.noReports({ ...who, items: sent.map((i) => ({ domain: i.domain.domain, liveAt: i.data.liveAt, check: i.data.check })), domainUrl: url!, emailCheck: emailCheckAvailable(w.env) }));
}

// ── Weekly facts, shared by the summary and the tips ─────────

interface WeekData {
  week: { start: number; end: number };
  /** Counted totals per domain: index 0..3 the four weeks before the week, 4 the week itself (so 3 is "last week" of the summary). */
  totals: Map<number, Totals[]>;
}

async function loadWeeks(w: W): Promise<WeekData> {
  const week = lastCompleteWeek(w.now);
  const from = week.start - 4 * WEEK;
  const rows = await w.q.reports.weekTotals(from, week.end);
  const totals = new Map<number, Totals[]>();
  for (const r of rows) {
    const t = totals.get(r.domain_id) ?? Array.from({ length: 5 }, () => noTotals());
    if (r.wk >= 0 && r.wk <= 4) t[r.wk] = { total: r.total, passed: r.passed, reports: r.reports };
    totals.set(r.domain_id, t);
  }
  return { week, totals };
}

const totalsOf = (data: WeekData, id: number): Totals[] => data.totals.get(id) ?? Array.from({ length: 5 }, () => noTotals());

/** Sources of one domain by week (0..4 as above), each week's failing capped by that week's exact failing total. */
async function weekSources(w: W, data: WeekData, d: DomainRow, weeks: number[]): Promise<Map<number, SourceStat[]>> {
  const from = data.week.start - 4 * WEEK;
  const lo = Math.min(...weeks), hi = Math.max(...weeks);
  const rows = await w.q.reports.sourcesByWeek(d.id, from + lo * WEEK, from + (hi + 1) * WEEK);
  const t = totalsOf(data, d.id);
  const out = new Map<number, SourceStat[]>();
  for (const wk of weeks) {
    const mine: WeekSourceRow[] = rows.filter((r) => r.wk + lo === wk);
    out.set(wk, sourceStats(mine, Math.max(0, t[wk].total - t[wk].passed)));
  }
  return out;
}

// e. weekly summary ---------------------------------------------

function tableRows(items: Array<{ domain: string; messages: number; passed: number; policy: string | null }>): copy.SummaryRow[] {
  const groups = new Map<string, typeof items>();
  for (const i of items) {
    const g = organizationalDomain(i.domain) ?? i.domain;
    groups.set(g, [...(groups.get(g) ?? []), i]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([g, rows]) => {
    const sorted = [...rows].sort((a, b) => (a.domain === g ? -1 : b.domain === g ? 1 : a.domain.localeCompare(b.domain)));
    const hasApex = sorted[0]?.domain === g;
    return sorted.map((r) => ({ ...r, indent: hasApex && r.domain !== g }));
  });
}

async function sendSummaries(w: W): Promise<void> {
  const week = lastCompleteWeek(w.now);
  const period = isoWeekId(week.start);
  const due = preferenceRecipients(w.people, w.prefs, 'summary', w.env).filter((r) => !hasClaim(w, r.userId, 0, 'summary', period));
  if (due.length === 0 || stopped(w.env, 'summary') || !w.base) return;
  const data = await loadWeeks(w);
  const sums: SummaryDomain[] = [];
  for (const d of w.domains) {
    const t = totalsOf(data, d.id);
    const base = { id: d.id, domain: d.domain, policy: d.dmarc_policy, this: t[4], last: t[3] };
    if (t[4].total === 0) { sums.push({ ...base, sources: [], lastSources: [], earlierKeys: new Set() }); continue; }
    const by = await weekSources(w, data, d, [0, 1, 2, 3, 4]);
    sums.push({ ...base, sources: by.get(4) ?? [], lastSources: by.get(3) ?? [], earlierKeys: new Set([0, 1, 2].flatMap((k) => (by.get(k) ?? []).filter((s) => s.messages > 0).map((s) => s.key))) });
  }
  const facts = summarise(sums);
  if (quietWeek(facts)) return;
  const uncounted = (await w.q.reports.uncountedWeek(week.start, week.end)).reduce((n, r) => n + r.reports, 0);
  const rows = tableRows(sums.map((s) => ({ domain: s.domain, messages: s.this.total, passed: s.this.passed, policy: s.policy })));
  const target = facts.todo ? w.domains.find((d) => d.domain === facts.todo!.domain) : w.domains.length === 1 ? w.domains[0] : undefined;
  const url = target ? appUrl(w.base, w.tenant.workspaceId, `/domains/${target.id}`) : appUrl(w.base, w.tenant.workspaceId, '/');
  for (const to of due) {
    const off = await preferenceOffUrl(w.env, to.userId, w.tenant.workspaceId, 'summary');
    if (!off) continue;
    await attempt(w, {
      kind: 'summary', to, claims: [{ domainId: 0, period }], offUrl: off,
      build: () => copy.weeklySummary({
        name: to.name, week, facts, rows, uncounted, domainUrl: url, domainName: target?.domain ?? null,
        footer: {
          why: to.role === 'owner' ? `Why am I getting this? You are the owner of ${w.workspaceName} on Ready Set Mail, and the weekly summary is on for you.` : `Why am I getting this? You are an admin of ${w.workspaceName} on Ready Set Mail and you turned the weekly summary on.`,
          settingsUrl: appUrl(w.base!, w.tenant.workspaceId, '/settings'), off: { label: 'Turn off the weekly summary', url: off },
        },
      }),
    });
  }
}

// f. tips -------------------------------------------------------

const storedFacts = (d: DomainRow): StoredDmarc => ({ dmarc_policy: d.dmarc_policy, dmarc_issue: d.dmarc_issue, dmarc_inherited_from: d.dmarc_inherited_from, dmarc_pct: d.dmarc_pct, dmarc_p: d.dmarc_p, dmarc_sp: d.dmarc_sp, dmarc_rua: d.dmarc_rua });

function liveFacts(d: DomainRow, lookup: DmarcLookup): StoredDmarc | null {
  const f = dmarcFactsFromLookup(lookup);
  if (!f) return null;
  return { dmarc_policy: f.policy, dmarc_issue: f.issue, dmarc_inherited_from: f.inherited_from, dmarc_pct: f.pct ?? null, dmarc_p: f.p ?? null, dmarc_sp: f.sp ?? null, dmarc_rua: sendsReportsHere(d.rua_address, f) ? 1 : 0 };
}

type PolicyTip =
  | { kind: 'tip_next'; period: string; inForce: InForce; step: DmarcStep; target: Policy }
  | { kind: 'tip_done'; period: 'reject'; inForce: InForce };

/** What the rule module says about a domain whose last two weeks were clean: the next step, or that there is none. Null: neither tip is true. */
function policyTip(d: DomainRow, facts: StoredDmarc, two: { total: number; passed: number }): PolicyTip | null {
  const f = policyInForce(d.domain, facts);
  if (f.kind !== 'own' && f.kind !== 'inherited') return null;
  if (f.policy === 'reject' && f.pct >= 100) return { kind: 'tip_done', period: 'reject', inForce: f };
  if (f.policy !== 'none' && f.policy !== 'quarantine') return null;
  const step = dmarcSteps(d.domain, f, { reportsAddress: true, ruaAddress: d.rua_address, reports: { total: two.total, passed: two.passed, days: 14 } })[0];
  if (!step || (step.key !== 'tighten' && step.key !== 'pct')) return null;
  // The policy the step moves to is read from the step's own words (`p=quarantine`, `sp=reject`); a pct step keeps the policy.
  const target = step.key === 'pct' ? f.policy : (/\b(?:s?p)=(quarantine|reject)\b/.exec(step.do)?.[1] as Policy | undefined);
  if (!target) return null;
  return { kind: 'tip_next', period: `policy:${f.policy}:${f.pct}`, inForce: f, step, target };
}

/** The offer paragraph's conditions: billing on, a price already cached (never a Stripe call per email), a postal address, and no order on the domain. */
async function offerFor(w: W, d: DomainRow): Promise<copy.OfferParagraph | null> {
  if (!billingEnabled(w.env) || !postalAddress(w.env)) return null;
  const cached = await cachedOfferPrice(w.env.DB, priceLookupKey(w.env)).catch(() => null);
  if (!cached || cached.currency !== 'usd' || cached.amount <= 0) return null;
  const orders = await w.tenant.scope.billing.orders.forDomain(d.domain).catch(() => null);
  if (!orders || orders.some((o) => ['pending', 'paid', 'started', 'done'].includes(o.status))) return null;
  const whole = cached.amount % 100 === 0; // the dashboard's own wording: $149 USD (web/src/lib/billing.ts formatMoney)
  const price = `$${(cached.amount / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })} USD`;
  return { price, orderUrl: appUrl(w.base!, w.tenant.workspaceId, `/domains/${d.id}`) };
}

interface Tip { kind: 'tip_fix' | 'tip_next' | 'tip_done'; domain: DomainRow; period: string; build: (to: Recipient, footer: Footer) => Mail }

async function sendTips(w: W): Promise<void> {
  if (stopped(w.env, 'tip_fix') || !w.base) return;
  const eligible = preferenceRecipients(w.people, w.prefs, 'tips', w.env).filter((r) => tipsSince(w, r.userId) === 0);
  if (eligible.length === 0) return;
  const data = await loadWeeks(w);
  const week = data.week;
  const twoWeeks = { start: week.start - WEEK, end: week.end };

  // Cheap, in-memory candidates first, in the order of what helps most; the reads for a candidate happen only when a person is about to get it.
  const lazy: Array<{ kind: Tip['kind']; domain: DomainRow; expand: () => Promise<Tip[]> }> = [];
  for (const d of w.domains) {
    const t = totalsOf(data, d.id);
    if (t[4].total - t[4].passed >= 10) {
      lazy.push({ kind: 'tip_fix', domain: d, expand: async () => {
        const stats = (await weekSources(w, data, d, [4])).get(4) ?? [];
        const offer = await offerFor(w, d);
        return tipFixSources(stats).map((s) => ({ kind: 'tip_fix' as const, domain: d, period: `src:${s.key}`, build: (to: Recipient, footer: Footer) => copy.tipFix({ name: to.name, footer, domain: d.domain, domainUrl: appUrl(w.base!, w.tenant.workspaceId, `/domains/${d.id}`), source: s, offer }) }));
      } });
    }
  }
  for (const d of w.domains) {
    const t = totalsOf(data, d.id);
    if (!allPassed(t[3]) || !allPassed(t[4])) continue;
    const two = { total: t[3].total + t[4].total, passed: t[3].passed + t[4].passed };
    const first = policyTip(d, storedFacts(d), two);
    if (!first) continue;
    lazy.push({ kind: first.kind, domain: d, expand: async () => {
      // The stored policy may be a day or more old (the daily DNS refresh is not always running), and a tip must never advise what the person already did: read it now.
      if (w.budget.tipReads <= 0) return [];
      w.budget.tipReads--;
      let tip: PolicyTip | null = null;
      try { const f = liveFacts(d, await readDmarc(w, d.domain)); tip = f ? policyTip(d, f, two) : null; } catch { tip = null; }
      if (!tip) return [];
      const sources = new Set([...(await weekSources(w, data, d, [3, 4])).values()].flatMap((stats) => stats.filter((x) => x.messages > 0).map((x) => x.key))).size;
      const url = appUrl(w.base!, w.tenant.workspaceId, `/domains/${d.id}`);
      const build = (to: Recipient, footer: Footer): Mail => tip!.kind === 'tip_done'
        ? copy.tipDone({ name: to.name, footer, domain: d.domain, domainUrl: url, messages: two.total, sources })
        : copy.tipNext({ name: to.name, footer, domain: d.domain, domainUrl: url, weeks: twoWeeks, messages: two.total, sources, inForce: tip!.inForce, step: tip!.step, target: tip!.target, ruaAddress: d.rua_address });
      return [{ kind: tip.kind, domain: d, period: tip.period, build }];
    } });
  }
  if (lazy.length === 0) return;

  const expanded = new Map<number, Tip[]>();
  for (const to of eligible) {
    if (tipsSince(w, to.userId) > 0 || !budgetLeft(w, to.userId)) continue;
    for (const [i, c] of lazy.entries()) {
      const tips = expanded.get(i) ?? await c.expand().catch(() => [] as Tip[]);
      expanded.set(i, tips);
      const tip = tips.find((t) => !hasClaim(w, to.userId, t.domain.id, t.kind, t.period));
      if (!tip) continue;
      const off = await preferenceOffUrl(w.env, to.userId, w.tenant.workspaceId, 'tips');
      if (!off) break;
      const footer: Footer = {
        why: to.role === 'owner' ? `Why am I getting this? You are the owner of ${w.workspaceName} on Ready Set Mail, and tips about your domains are on for you.` : `Why am I getting this? You are an admin of ${w.workspaceName} on Ready Set Mail and you turned tips about your domains on.`,
        settingsUrl: appUrl(w.base, w.tenant.workspaceId, '/settings'), off: { label: 'Turn off tips about your domains', url: off },
      };
      await attempt(w, { kind: tip.kind, to, claims: [{ domainId: tip.domain.id, period: tip.period }], offUrl: off, build: () => tip.build(to, footer) });
      break; // at most one tip per person per 7 days
    }
  }
}

// ── Entry points ─────────────────────────────────────────────

/** `requireVerified`: the hosted rules (verified addresses, proven domains); self-host, which has neither, passes false (the first-report email only). */
async function load(tenant: TenantContext, ctx: Ctx, budget: Budget, deps: LifecycleDeps, requireVerified: boolean): Promise<W | null> {
  const env = tenant.env;
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const all = await tenant.scope.domains.list();
  if (all.length === 0) return null;
  // Hosted: only proven domains (a domain not proven is not the workspace's to be told about). Self-host has no ownership proof to ask for: every domain counts.
  const proven = requireVerified ? provenDomainIds(all) : null;
  const domains = all.filter((d) => (!proven || proven.has(d.id)) && d.rua_address.trim() !== '');
  if (domains.length === 0) return null;
  const q = tenant.scope.lifecycleEmail;
  const [people, prefs, sends, adders, milestones] = await Promise.all([q.recipients(), q.preferences.all(), q.sends.all(), q.domainAdders(), q.milestones.list()]);
  const adderMap = new Map<number, Set<string>>();
  for (const a of adders) adderMap.set(a.domain_id, new Set([...(adderMap.get(a.domain_id) ?? []), a.actor_id]));
  const name = (await workspaceLifecycle(env.DB).get(tenant.workspaceId).catch(() => null))?.name;
  return {
    tenant, env, ctx, budget, deps, now, q, base: publicBaseUrl(env), requireVerified, workspaceName: name ?? 'your workspace',
    mailer: deps.mailer !== undefined ? deps.mailer : ownerMailer(env),
    from: deps.from ?? (await accountSender(env, tenant)),
    domains, people, prefs, sends, adders: adderMap, milestones: new Map(milestones.map((m) => [m.domain_id, m])),
  };
}

/**
 * Which cron expression runs which part: the milestones in the daily `0 11 * * *` branch, the weekly summary and the tips in the weekly
 * `0 9 * * 1` branch (src/cron.ts; docs/hosted.md has the table). 'both': everything, for a caller that has no cron (tests).
 */
export type Schedule = 'daily' | 'weekly' | 'both';
const PARTS: ReadonlyArray<readonly [string, Exclude<Schedule, 'both'>, (w: W) => Promise<void>]> = [
  ['watch', 'daily', watchForLive], ['records live', 'daily', sendRecordsLive], ['first report', 'daily', (x) => sendFirstReports(x)],
  ['no reports', 'daily', sendNoReports], ['summary', 'weekly', sendSummaries], ['tips', 'weekly', sendTips],
];

/**
 * The lifecycle work of one workspace (hosted only). Each part is on its own: one failing never stops the next, and nothing here throws.
 * The order is the order of importance: when the invocation's budget runs out, the milestones were sent first.
 */
export async function runLifecycleForWorkspace(tenant: TenantContext, ctx: Ctx, budget: Budget, deps: LifecycleDeps = {}, schedule: Schedule = 'both'): Promise<void> {
  if (!hostedEnabled(tenant.env)) return;
  let w: W | null;
  try {
    w = await load(tenant, ctx, budget, deps, true);
  } catch (e) {
    console.error('[lifecycle] could not load the workspace:', e instanceof Error ? e.name : 'error');
    return;
  }
  if (!w) return;
  const parts = PARTS.filter(([, runs]) => schedule === 'both' || runs === schedule);
  for (const [name, , part] of parts) {
    if (budget.sends <= 0) break;
    try { await part(w); } catch (e) { console.error(`[lifecycle] ${name} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : 'error'); }
  }
}

/**
 * The first counted report of a domain has just been stored: tell the people it concerns, now (src/notifications/first-report.ts). One module for
 * both modes: on self-host the recipients are the owners (no verified-address rule, nobody is asked to verify one), the sender the workspace's own
 * or the platform's, the link the public origin (PUBLIC_BASE_URL, else BETTER_AUTH_URL).
 */
export async function sendFirstReportNow(tenant: TenantContext, ctx: Ctx, domainId: number, reportId: number, deps: LifecycleDeps = {}): Promise<void> {
  const w = await load(tenant, ctx, newBudget(), deps, getMode(tenant.env) === 'saas');
  if (!w) return;
  await sendFirstReports(w, { domainId, reportId });
}

