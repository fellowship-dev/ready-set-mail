// The words and rules of SPF flattening on the dashboard, in one place: the domain-page card and the wizard say the same thing about the same state.
// Every sentence is true for the state it is shown in (docs/spf-flattening.md, "What the screen says"). No price, no promise the daily check does not keep.
import type { SpfFlatConfig, SpfFlatStatus, SpfProblemKind } from './types';
import { formatDate, timeAgo } from './format';

/** When the daily check runs (wrangler.jsonc `0 11 * * *`). */
export const SPF_CHECK_AT = '11:00 UTC';
/** Over this long since the last successful check, the card says the daily check has not run. */
export const SPF_STALE_SECONDS = 2 * 86400;
export const SPF_LOOKUP_ALLOWED = 10;

export type SpfAction = 'try_again' | 'reconnect' | 'turn_off' | 'review' | 'retry_restore';

/** The one thing a person can do about a problem. */
export const PROBLEM_ACTION: Record<SpfProblemKind, SpfAction> = {
	include_unresolved: 'try_again',
	no_addresses: 'try_again',
	connection_lost: 'reconnect',
	too_large: 'turn_off',
	macro: 'turn_off',
	edited_outside: 'review',
	record_missing: 'review',
	restore_failed: 'retry_restore',
};

export const ACTION_LABEL: Record<SpfAction, string> = {
	try_again: 'Try again',
	reconnect: 'Reconnect Cloudflare',
	turn_off: 'Turn off',
	review: 'Review',
	retry_restore: 'Try again',
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The state of a domain's flattening, for the card and the wizard's last step. */
export type SpfState =
	| { kind: 'off' }
	| { kind: 'on'; config: SpfFlatConfig; stale: boolean }
	| { kind: 'problem'; config: SpfFlatConfig; problem: NonNullable<SpfFlatConfig['problem']>; action: SpfAction }
	| { kind: 'turning_off_failed'; config: SpfFlatConfig; message: string };

export function spfState(s: SpfFlatStatus, now = Date.now() / 1000): SpfState {
	const c = s.config;
	if (!c) return { kind: 'off' };
	if (!c.enabled) return { kind: 'turning_off_failed', config: c, message: c.problem?.message ?? 'We could not put your original record back in Cloudflare.' };
	if (c.problem) return { kind: 'problem', config: c, problem: c.problem, action: PROBLEM_ACTION[c.problem.kind] };
	return { kind: 'on', config: c, stale: c.last_refreshed_at !== null && now - c.last_refreshed_at > SPF_STALE_SECONDS };
}

/** "On: 23 addresses in your record, using 7 of the 10 lookups. Checked 2 hours ago; not changed since you turned it on. Checked again every day around 11:00 UTC." */
export function onSentence(c: SpfFlatConfig, now = Date.now() / 1000): string {
	const addresses = c.ip_count !== null ? plural(c.ip_count, 'address', 'addresses') : 'addresses';
	const lookups = c.lookups_after !== null ? `, using ${c.lookups_after} of the ${SPF_LOOKUP_ALLOWED} lookups` : '';
	const checked = c.last_refreshed_at !== null ? `Checked ${timeAgo(c.last_refreshed_at, now)}` : 'Not checked yet';
	const changed = c.previous_record !== null && c.last_changed_at !== null ? `changed on ${formatDate(c.last_changed_at)}` : 'not changed since you turned it on';
	return `On: ${addresses} in your record${lookups}. ${checked}; ${changed}. Checked again every day around ${SPF_CHECK_AT}.`;
}

export function staleSentence(c: SpfFlatConfig): string {
	return `Last checked ${c.last_refreshed_at !== null ? formatDate(c.last_refreshed_at) : 'never'}. The daily check has not run since.`;
}

/** The card's text when flattening is off. `count`: the lookups the record needs now, when known. */
export function offSentence(count: number | null): string {
	if (count === null) return 'Replace the includes in your SPF record with the addresses behind them.';
	if (count <= SPF_LOOKUP_ALLOWED) return `Your record uses ${count} of the ${SPF_LOOKUP_ALLOWED} lookups receivers allow, so it does not need flattening.`;
	return `Your record needs ${count} lookups; receivers stop at ${SPF_LOOKUP_ALLOWED}. Flattening replaces the includes with the addresses behind them.`;
}

export const NOT_ALLOWED_ON_SENTENCE = 'Flattening is not switched on for this workspace any more, so the record is no longer refreshed. It still lists the addresses from the last check.';
