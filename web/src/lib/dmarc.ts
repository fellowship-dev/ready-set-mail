import { parseDmarcSp } from './dmarc-record';
import type { WizardState } from './types';

/** What people paste into the box: trim, lowercase, drop a scheme and one trailing slash. */
export function normalizeDomain(input: string): string {
	return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export { buildRecommendedRecord } from './dmarc-record';

/** `sp=` tag of a live record, if any. */
export function spTag(record: string | null): string | null {
	return parseDmarcSp(record);
}


export interface DayStat {
	total: number;
	passed: number;
	failed: number;
}

export function sumStats(stats: DayStat[]): { total: number; passed: number; failed: number; passRate: number | null } {
	const total = stats.reduce((n, r) => n + r.total, 0);
	const passed = stats.reduce((n, r) => n + r.passed, 0);
	const failed = stats.reduce((n, r) => n + r.failed, 0);
	return { total, passed, failed, passRate: total > 0 ? Math.round((passed / total) * 100) : null };
}

const SETUP_STEPS = ['domain', 'spf', 'dkim', 'dmarc', 'routing'] as const;

/**
 * Setup progress out of the wizard's five steps, counted the same way everywhere: the wizard's "n of 5 steps
 * complete" and the "Continue setup n/5" links. A domain that exists has done the domain step, even when it was
 * added outside the wizard and its stored state still says not_started.
 * `hosted`: the fifth step (Reports) only says reports are not connected, so it is never done and never counted:
 * progress is out of four.
 */
export function wizardProgress(state: WizardState, { hosted = false }: { hosted?: boolean } = {}): { done: number; skipped: number; total: number; nextStep: number } {
	const steps = hosted ? SETUP_STEPS.filter((k) => k !== 'routing') : SETUP_STEPS;
	const stateOf = (k: (typeof SETUP_STEPS)[number]) => (k === 'domain' ? 'complete' : state[k]);
	const done = steps.filter((k) => stateOf(k) === 'complete').length;
	const skipped = steps.filter((k) => stateOf(k) === 'skipped').length;
	const firstIncomplete = steps.findIndex((k, i) => i > 0 && state[k] !== 'complete');
	return { done, skipped, total: steps.length, nextStep: firstIncomplete > 0 ? firstIncomplete + 1 : 2 };
}
