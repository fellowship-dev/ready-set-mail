// The report evidence the one DMARC rule weighs (dmarc-next-step.ts), built ONCE for the dashboard and the agent tools, so
// both pass the same facts: the reports address, the 30-day totals, the public-suffix note, the per-domain answer on
// whether reports can be connected here (`report_connect`), and why an empty window is empty (the report visibility fields
// of src/reports/visibility.ts). Pure and dependency-free.

import { isReportAddress, type DmarcEvidence, type ReportsRefusal } from './dmarc-next-step';

/** The report visibility fields this module reads (src/reports/visibility.ts sends them; older servers may not). */
export interface VisibilityFacts {
  counting_note?: string | null;
  uncounted?: { reports: number; unknown?: number; unauthenticated?: number } | null;
  intake?: {
    status: 'ok' | 'limited' | 'not_processed';
    notice: string | null;
    /** Known reporters whose counted reports were not stored; `text` is the sentence with the time in UTC. */
    dropped?: Array<{ label: string; since: string; text: string }>;
  } | null;
}

/** How a dropped-report sentence is written: the server uses its UTC `text`; the dashboard localises the time. */
export type DropText = (d: { label: string; since: string; text: string }) => string;

/** Why a window that shows no counted numbers is empty. Never `none` while reports were left out or lost. */
export type EmptyReportsState = 'counted' | 'none' | 'only_unrecognised' | 'not_processed' | 'limited' | 'blocked';

export function emptyReportsState(totalCountedMessages: number, v: VisibilityFacts | null | undefined): EmptyReportsState {
  if (v?.intake?.status === 'limited') return 'limited';
  if (v?.intake?.status === 'not_processed' && totalCountedMessages === 0) return 'not_processed';
  if (totalCountedMessages > 0) return 'counted';
  if (v?.counting_note) return 'blocked';
  if ((v?.uncounted?.reports ?? 0) > 0) return 'only_unrecognised';
  return 'none';
}

/** "3 reports from senders we do not recognise are not counted." — or null when nothing is left out. */
export function uncountedNotice(v: VisibilityFacts | null | undefined): string | null {
  const u = v?.uncounted;
  const n = u?.reports ?? 0;
  if (!u || n <= 0) return null;
  const unauth = u.unauthenticated ?? 0;
  const unknown = u.unknown ?? n - unauth;
  const parts: string[] = [];
  if (unknown > 0) parts.push(unknown === 1 ? '1 report from a sender we do not recognise is not counted.' : `${unknown} reports from senders we do not recognise are not counted.`);
  if (unauth > 0) parts.push(unauth === 1 ? '1 report from a sender that could not be authenticated is not counted.' : `${unauth} reports from senders that could not be authenticated are not counted.`);
  return parts.join(' ') || null;
}

/** The storage limit or not-processed sentence; known reporters' dropped reports are named. Null when all is well. */
export function intakeNotice(v: VisibilityFacts | null | undefined, dropText: DropText = (d) => d.text): string | null {
  const drops = (v?.intake?.dropped ?? []).map(dropText);
  return drops.length ? drops.join('. ') : v?.intake?.notice ?? null;
}

/** The sentence for the empty state, or null for `counted`. `none` is the only state that may say there are no reports. */
export function emptyReportsMessage(totalCountedMessages: number, v: VisibilityFacts | null | undefined, dropText?: DropText): string | null {
  switch (emptyReportsState(totalCountedMessages, v)) {
    case 'counted': return null;
    case 'limited': return intakeNotice(v, dropText);
    case 'not_processed': return intakeNotice(v, dropText);
    case 'blocked': return v?.counting_note ?? null;
    case 'only_unrecognised': return `No counted reports yet. ${uncountedNotice(v)}`;
    case 'none': return 'No reports yet.';
  }
}

/** The per-domain answer on connecting reports, as the server sends it (`report_connect`). */
export interface ReportConnectFacts {
  can_connect: boolean;
  refusal: string | null;
  refusal_kind: ReportsRefusal['kind'] | null;
}

/** Why reports cannot be connected for a domain (null: they can, or not known). */
export function reportsRefusalOf(c: ReportConnectFacts | null | undefined): ReportsRefusal | null {
  return c && !c.can_connect && c.refusal_kind ? { kind: c.refusal_kind, reason: c.refusal ?? '' } : null;
}

/**
 * The evidence for one domain. Without a reports address no pass share is used (old totals are not a current claim).
 * `visibility`: an empty window that still had reports (dropped, limited, not counted) is said as such, never as "none
 * arrived". `reportConnect`: the server's answer on connecting reports. `alignment`: the governing record's adkim=/aspf=.
 */
export function dmarcEvidenceFor(input: {
  ruaAddress: string | null | undefined;
  reports: { total: number; passed: number; days: number } | null | undefined;
  suffixParent?: string | null;
  visibility?: VisibilityFacts | null;
  alignment?: DmarcEvidence['alignment'];
  reportConnect?: ReportConnectFacts | null;
  /** The refusal already derived from `report_connect` (takes precedence over `reportConnect`). */
  reportsRefusal?: ReportsRefusal | null;
  /** The ruaAddress returned in the evidence (offered records): the agent tools never return the address. */
  offeredRua?: string | null;
  dropText?: DropText;
}): DmarcEvidence {
  const { reports } = input;
  const emptyReportsNote = reports && reports.total === 0 && emptyReportsState(0, input.visibility) !== 'none' ? emptyReportsMessage(0, input.visibility, input.dropText) : null;
  return {
    reportsAddress: isReportAddress(input.ruaAddress),
    ruaAddress: input.offeredRua === undefined ? input.ruaAddress : input.offeredRua,
    reports: reports ? { total: reports.total, passed: reports.passed, days: reports.days } : reports,
    suffixParent: input.suffixParent ?? null,
    alignment: input.alignment ?? null,
    reportsRefusal: input.reportsRefusal !== undefined ? input.reportsRefusal : reportsRefusalOf(input.reportConnect),
    emptyReportsNote,
  };
}
