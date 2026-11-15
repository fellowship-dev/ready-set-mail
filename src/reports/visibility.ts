// What the owner must be told besides the numbers (G5, G6, G7): reports that were stored but are not counted, and mail that reached
// the report address and could not be stored. These are API fields; the dashboard, the digest and agents render them. They exist so the
// UI never shows "no reports" (or a healthy-looking 100%) while reports were received and left out or lost.

import type { UncountedSummary, CountingMode, FailureRow, DropRow } from '@ready-set-mail/db';
import type { TenantContext } from '../tenancy/context';
import { intakeLimits } from '../hosted/config';
import { hostedEnabled } from '../hosted/config';
import { isMajorReporter, MAJOR_REPORTER_IDS } from '../dmarc/known-reporters';
import { OWNER_VISIBLE, REASONS, type ReasonCode } from '../hosted/reasons';

const authservConfigured = (env: { AUTHSERV_ID?: string; AUTHSERV_HEADER?: string }) => !!env.AUTHSERV_ID?.trim() && ['ar', 'arc'].includes(env.AUTHSERV_HEADER?.trim().toLowerCase() ?? '');

const DAY = 86400;
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
/** How far back the owner is told about reports that could not be processed. */
export const FAILURE_WINDOW_DAYS = 14;

export interface UncountedView {
  /** Reports in the window that are not counted in the numbers (0 when every stored report counts). */
  reports: number;
  messages: number;
  latest_at: number | null;
  /** Of `reports`: authenticated but not in the registry, and not authenticated. */
  unknown: number;
  unauthenticated: number;
  by_reporter: UncountedSummary['by_reporter'];
}

export type IntakeStatus = 'ok' | 'limited' | 'not_processed';

export interface IntakeView {
  status: IntakeStatus;
  /** Mail that reached this address and was not stored, last FAILURE_WINDOW_DAYS days. */
  not_processed: { messages: number; last_at: number | null; reasons: Array<{ reason: string; messages: number; last_at: number; text: string }> };
  /** Which limit is in force right now, if any (`limited`). 'counted_storage_dropped': reports of a known reporter were accepted and NOT stored (see `dropped`). */
  limit: null | 'workspace_storage' | 'instance_storage' | 'address_day' | 'workspace_day' | 'counted_storage_dropped';
  /**
   * Known reporters whose COUNTED reports were not stored because the counted budget was full, until a report of theirs is stored again. Times are ISO 8601
   * (UTC): the web renders them in the user's locale and time zone (`storageDropNotice` in web/src/lib/uncounted.ts). `text` is the same sentence with the time in UTC.
   */
  dropped: Array<{ reporter: string; label: string; since: string; last_at: string; messages: number; text: string }>;
  /** One plain sentence for the owner, or null when all is well. */
  notice: string | null;
}

export interface ReportVisibility {
  report_counting: CountingMode;
  /** Why nothing can be counted right now (AUTHSERV_* not set while the mode needs authentication), or null. */
  counting_note: string | null;
  /** Stored reports from senders we do not recognise (authenticated but not a known reporter, or not authenticated), whatever the mode. */
  unrecognised: UncountedView;
  /** The part that is left out of the numbers in this mode (empty when report_counting is 'all'). */
  uncounted: UncountedView;
  /** Who the counted numbers come from (registry reporters), with the sentence that names them. */
  reporters: ReporterMix;
  intake: IntakeView;
}

export interface ReporterMix {
  counted: Array<{ reporter: string; label: string; reports: number; messages: number }>;
  /** "from 12 reports by Google, Microsoft", or null when nothing is counted. */
  attribution: string | null;
  /** At least one report from Google or Microsoft is counted in the window: "safe to enforce" advice needs it. */
  major: boolean;
}

/** The reporters whose counted reports carry the advice: the two receivers that see most of the mail. */
export const MAJOR_REPORTERS: readonly string[] = MAJOR_REPORTER_IDS;

export function reporterMix(rows: ReporterMix['counted']): ReporterMix {
  const reports = rows.reduce((n, r) => n + Number(r.reports), 0);
  return {
    counted: rows,
    attribution: reports ? `from ${reports} ${reports === 1 ? 'report' : 'reports'} by ${rows.map((r) => r.label).join(', ')}` : null,
    major: rows.some((r) => isMajorReporter(r.reporter)),
  };
}


export const STORAGE_LIMIT_NOTICE = 'Report storage limit reached; newer reports are not being stored';
/** The loud state for counted reports that could not be stored: "Report storage limit reached; reports from Google since <time> were not stored". */
export const storageDropText = (reporterLabel: string, time: string) => `Report storage limit reached; reports from ${reporterLabel} since ${time} were not stored`;
/** UTC rendering for server-side text (the setup check, agents): 2026-11-14 03:12 UTC. */
export const utcMinute = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export const DAILY_LIMIT_NOTICE = 'Daily report limit reached for this address; newer reports are not being stored until tomorrow';

/** "3 reports from senders we do not recognise are not counted." (authenticated, not in the registry: stored, never counted). */
export const uncountedNotice = (n: number) => (n === 1 ? '1 report from a sender we do not recognise is not counted.' : `${n} reports from senders we do not recognise are not counted.`);

/** A separate line for reports whose sender could not be authenticated at all. */
export const unauthenticatedNotice = (n: number) => (n === 1 ? '1 report from a sender that could not be authenticated is not counted.' : `${n} reports from senders that could not be authenticated are not counted.`);

/** For a server that counts every report ('all'): how many counted reports come from senders we do not recognise. */
export const unrecognisedCountedNotice = (n: number) =>
  n === 1 ? '1 report is from a sender we do not recognise; it is counted because this server counts every report.' : `${n} reports are from senders we do not recognise; they are counted because this server counts every report.`;

export const AUTHSERV_NOTICE = 'No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set.';
/** The same state as a hosted customer reads it: the configuration is the operator's, not theirs. */
export const AUTHSERV_CUSTOMER_NOTICE = 'Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do.';

/**
 * Why nothing can be counted, in the words of whoever reads it: the operator (and anyone on a self-hosted instance, who runs it) is
 * told which settings are missing; a hosted customer is told it is on our side. `operator`: the caller runs this instance
 * (TenantContext.operatorView, set by the router from isInstanceOwner). Null when reports can be counted.
 */
export function countingNote(tenant: Pick<TenantContext, 'env' | 'mode' | 'operatorView'> & { scope: { counting: CountingMode } }): string | null {
  if (tenant.scope.counting === 'all' || authservConfigured(tenant.env)) return null;
  return tenant.mode !== 'saas' || tenant.operatorView ? AUTHSERV_NOTICE : AUTHSERV_CUSTOMER_NOTICE;
}

/** "3 reports could not be processed" / "1 report could not be processed". */
export const notProcessedNotice = (n: number) => `${n} ${n === 1 ? 'report' : 'reports'} received for this domain could not be processed`;

/** The text for a failure reason code, as the owner reads it. */
function reasonText(reason: string): string {
  return reason in REASONS ? REASONS[reason as ReasonCode] : reason;
}

export function intakeView(failures: FailureRow[], usage: { addressMessagesToday: number; workspaceMessagesToday: number; workspaceRecords: number; instanceRecords: number } | null, limits: ReturnType<typeof intakeLimits> | null, drops: DropRow[] = []): IntakeView {
  const dropped: IntakeView['dropped'] = drops.map((d) => ({ reporter: d.reporter, label: d.label, since: new Date(d.first_at * 1000).toISOString(), last_at: new Date(d.last_at * 1000).toISOString(), messages: Number(d.messages), text: storageDropText(d.label, utcMinute(d.first_at)) }));
  const rows = failures.filter((f) => OWNER_VISIBLE.has(f.reason as ReasonCode));
  const messages = rows.reduce((n, f) => n + Number(f.messages), 0);
  const last = rows.reduce<number | null>((m, f) => (m === null || f.last_at > m ? f.last_at : m), null);
  let limit: IntakeView['limit'] = null;
  if (usage && limits) {
    if (usage.workspaceRecords >= limits.workspaceRecords) limit = 'workspace_storage';
    else if (usage.instanceRecords >= limits.instanceRecords) limit = 'instance_storage';
    else if (usage.addressMessagesToday >= limits.addressMessagesPerDay) limit = 'address_day';
    else if (usage.workspaceMessagesToday >= limits.workspaceMessagesPerDay) limit = 'workspace_day';
  }
  if (dropped.length) limit = 'counted_storage_dropped'; // the most specific statement: it names who was not stored
  const status: IntakeStatus = limit ? 'limited' : messages > 0 ? 'not_processed' : 'ok';
  const notice = limit === 'counted_storage_dropped' ? dropped.map((d) => d.text).join('. ')
    : limit === 'workspace_storage' || limit === 'instance_storage' ? STORAGE_LIMIT_NOTICE
    : limit ? DAILY_LIMIT_NOTICE
    : messages > 0 ? notProcessedNotice(messages) : null;
  return {
    status, limit, notice, dropped,
    not_processed: { messages, last_at: last, reasons: rows.map((f) => ({ reason: f.reason, messages: Number(f.messages), last_at: f.last_at, text: reasonText(f.reason) })) },
  };
}

/** Everything above for one domain: `since` (unix seconds) is the same window the numbers use. The one-domain case of reportVisibilityMany. */
export async function reportVisibility(tenant: TenantContext, domainId: number, since: number, nowSeconds = Math.floor(Date.now() / 1000), by: 'period' | 'received' = 'period'): Promise<ReportVisibility> {
  return (await reportVisibilityMany(tenant, { fromId: domainId, toId: domainId }, since, nowSeconds, by))(domainId);
}

const emptyUncounted = (): UncountedView => ({ reports: 0, messages: 0, latest_at: null, unknown: 0, unauthenticated: 0, by_reporter: [] });

/**
 * The visibility of every domain whose id is in `range` (a page of the overview, or one domain), from six statements whatever the
 * number of domains (five in `all` counting mode): reports per reporter (unrecognised, uncounted, counted), drops, failures and the
 * intake counters, each grouped by domain. Returns the view for a domain id (an id with nothing stored gets the empty view).
 */
export async function reportVisibilityMany(tenant: TenantContext, range: { fromId: number; toId: number }, since: number, nowSeconds = Math.floor(Date.now() / 1000), by: 'period' | 'received' = 'period'): Promise<(domainId: number) => ReportVisibility> {
  const counting = tenant.scope.counting;
  const [reports, intake] = await Promise.all([
    tenant.scope.reports.visibilityByDomain(range, since, by),
    tenant.scope.intake.intakeByDomain(range, nowSeconds - FAILURE_WINDOW_DAYS * DAY, day(nowSeconds - FAILURE_WINDOW_DAYS * DAY), day(nowSeconds)),
  ]);
  const hosted = hostedEnabled(tenant.env);
  const counting_note = countingNote(tenant);
  return (domainId) => ({
    report_counting: counting,
    counting_note,
    unrecognised: reports.unrecognised.get(domainId) ?? emptyUncounted(),
    uncounted: reports.uncounted.get(domainId) ?? emptyUncounted(),
    reporters: reporterMix(reports.counted.get(domainId) ?? []),
    // The caps only apply to hosted intake; self-host has no daily caps to hit.
    intake: intakeView(intake.failures.get(domainId) ?? [], hosted ? intake.usage(domainId) : null, hosted ? intakeLimits(tenant.env) : null, intake.drops.get(domainId) ?? []),
  });
}
