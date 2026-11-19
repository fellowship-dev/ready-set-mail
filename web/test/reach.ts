import type { ReportReach } from '../src/lib/report-address';

/** The report-address view's `reach` for a name nothing reaches by itself: the state of the connection speaks. */
export const noReach: ReportReach = { kind: 'none', through: null, reports: 0, messages: 0, last_report_at: null, days: 30 };
/** Its reports arrive through a connected parent, with the counts of the reports filed for it. */
export const viaParentReach = (through: { domain_id: number; domain: string }, over: Partial<ReportReach> = {}): ReportReach => ({ kind: 'via_parent', through, reports: 0, messages: 0, last_report_at: null, days: 30, ...over });
/** The record that applies to it (its parent's) already sends reports here. */
export const inheritedReach = (through: { domain_id: number; domain: string }, over: Partial<ReportReach> = {}): ReportReach => ({ kind: 'inherited_record', through, reports: 0, messages: 0, last_report_at: null, days: 30, ...over });
