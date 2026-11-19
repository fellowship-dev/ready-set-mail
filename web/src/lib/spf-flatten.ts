// The words and rules of SPF flattening on the dashboard, in one place: the domain-page card and the wizard say the same thing about the same state.
// Every sentence is true for the state it is shown in (docs/spf-flattening.md, "What the screen says"). No price, no promise the daily check does not keep.
import type { SpfFlatConfig, SpfFlatStatus, SpfPending, SpfProblemKind } from './types';
import { formatDate, timeAgo } from './format';

/** When the daily check runs (wrangler.jsonc `0 11 * * *`). */
export const SPF_CHECK_AT = '11:00 UTC';
/** Over this long since the last successful check, the card says the daily check has not run. */
export const SPF_STALE_SECONDS = 2 * 86400;
export const SPF_LOOKUP_ALLOWED = 10;

export type SpfAction = 'try_again' | 'reconnect' | 'turn_off' | 'review' | 'retry_restore' | 'prove';

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
	connection_gone: 'reconnect',
	proof_lost: 'prove',
};

export const ACTION_LABEL: Record<SpfAction, string> = {
	try_again: 'Try again',
	reconnect: 'Reconnect Cloudflare',
	turn_off: 'Turn off',
	review: 'Review',
	retry_restore: 'Try again',
	prove: 'Prove ownership again',
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The state of a domain's flattening, for the card and the wizard's last step. */
export type SpfState =
	| { kind: 'off' }
	| { kind: 'on'; config: SpfFlatConfig; stale: boolean }
	| { kind: 'problem'; config: SpfFlatConfig; problem: NonNullable<SpfFlatConfig['problem']>; action: SpfAction }
	| { kind: 'turning_off_failed'; config: SpfFlatConfig; message: string }
	/** Flattening stopped because nothing can be written any more: the connection is gone, or ownership is no longer proven. */
	| { kind: 'stopped'; config: SpfFlatConfig; reason: 'connection_gone' | 'proof_lost' };

export function spfState(s: SpfFlatStatus, now = Date.now() / 1000): SpfState {
	const c = s.config;
	if (!c) return { kind: 'off' };
	if (!c.enabled && (c.problem?.kind === 'connection_gone' || c.problem?.kind === 'proof_lost')) return { kind: 'stopped', config: c, reason: c.problem.kind };
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

// ── A removal that waits (docs/adr/0028) ────────────────────

/** Why the wait is what it is: the longest provider record we measured lives 4 hours in a cache (ADR 0028). */
export const PENDING_WHY = 'We wait at least 4 hours so the second look is a fresh answer from the provider, not a copy of the first.';
export const CHECK_AGAIN_NOW = 'Check again now';

/** "15:20 UTC", with the day when it is not today. */
export function utcClock(at: number, now = Date.now() / 1000): string {
	const d = new Date(at * 1000).toISOString();
	const sameDay = new Date(now * 1000).toISOString().slice(0, 10) === d.slice(0, 10);
	const day = sameDay ? '' : ` on ${Number(d.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1]}`;
	return `${d.slice(11, 16)} UTC${day}`;
}

const isAddress = (e: string) => /^ip[46]:/i.test(e);
/** "2 addresses", or "1 address and 1 other term" when the held entries include a lookup term. */
export function heldCount(entries: string[]): string {
	const a = entries.filter(isAddress).length;
	const o = entries.length - a;
	const addresses = plural(a, 'address', 'addresses');
	return o === 0 ? addresses : a === 0 ? plural(o, 'term') : `${addresses} and ${plural(o, 'other term')}`;
}

/**
 * The first sentence of a waiting removal: which provider, how much is held. "_spf.foxtrot-help.net no longer lists 2 addresses." The word "now lists no addresses"
 * is not used: the card only knows what was held, not what the provider still lists.
 */
export function pendingWhat(p: SpfPending): string {
	return `${p.providers.map((name) => `${name} no longer lists ${heldCount(p.removed[name] ?? [])}`).join('; ')}.`;
}

/** The whole text of the waiting state, as the card and the page both say it. */
export function pendingSentence(p: SpfPending, now = Date.now() / 1000): string {
	const held = p.providers.length === 1 && Object.values(p.removed).flat().length === 1 ? 'it' : 'them';
	const when = utcClock(p.confirm_after, now);
	const first = `Waiting to confirm a change: ${pendingWhat(p)} We kept ${held} in your record and will take ${held} out only if the next check, after ${when}, sees the same.`;
	return `${first} ${p.additions_written ? 'Anything new from your providers is already in your record.' : 'New addresses are not in your record yet: with the held ones they would not fit in one record, so nothing was written.'}`;
}

/** The terms of `live` that `flat` does not have: what replacing an edit with the flattened record drops. */
export function droppedTerms(live: string, flat: string): string[] {
	const have = new Set(flat.trim().split(/\s+/).map((t) => t.toLowerCase()));
	return live.trim().split(/\s+/).filter((t) => !/^v=spf1$/i.test(t) && !have.has(t.toLowerCase()));
}

/** Flattening stopped for good reason: nothing can be written any more. One sentence, true for the state; the records are shown beside it. */
export function stoppedSentence(reason: 'connection_gone' | 'proof_lost'): string {
	return reason === 'connection_gone'
		? 'Ready Set Mail can no longer change this record: its Cloudflare connection is gone. The daily check has stopped, and nothing more will be written. To go back to your original, copy it into the SPF record in Cloudflare below, or reconnect Cloudflare and try again.'
		: 'Ready Set Mail can no longer show that you control this domain, so the daily check has stopped and nothing more will be written. To go back to your original, copy it into the SPF record in Cloudflare below, or prove ownership again.';
}

/** Said before turning on, once, plainly: what flattening costs. */
export const TURN_ON_RISK = 'When a provider starts sending from new addresses, mail from them can fail SPF until the next daily check, up to about a day.';
/** For a record that is within the limits: who should not use it, and why. */
export const NOT_NEEDED_WHY = 'Flattening is for records that need more than 10 lookups. Within the limit, a record with includes follows its providers as they change; a flattened one follows them once a day.';

/**
 * The one line at the top of the domain page while flattening is on (or was): its state in a few words and where the whole state is. Null when flattening was never
 * on. Basis: the reviewer found the card 1.6 screens down in a closed disclosure after turning on; owner's rule T1 (the thing to look at is on the first screen) and ADR 0012
 * (the status is the page the person lands on after turning on, so the way back to it is one tap).
 */
export function statusLine(s: SpfFlatStatus, now = Date.now() / 1000): { text: string; tone: 'ok' | 'wait' | 'attention' } | null {
	const st = spfState(s, now);
	if (st.kind === 'off') return null;
	if (s.access?.allowed === false) return { text: 'SPF flattening is no longer switched on for this workspace; your record keeps the addresses of the last check.', tone: 'attention' };
	if (st.kind === 'stopped') return { text: st.reason === 'connection_gone' ? 'SPF flattening has stopped: Cloudflare can no longer be changed from here.' : 'SPF flattening has stopped: we can no longer show you control this domain.', tone: 'attention' };
	if (st.kind === 'turning_off_failed') return { text: 'Turning off SPF flattening did not finish: your original record is not back yet.', tone: 'attention' };
	if (st.kind === 'problem') return { text: 'SPF flattening needs attention.', tone: 'attention' };
	const c = st.config;
	if (c.pending) return { text: `SPF flattening: waiting to confirm a change, after ${utcClock(c.pending.confirm_after, now)}.`, tone: 'wait' };
	const lookups = c.lookups_after !== null ? ` · ${c.lookups_after} of ${SPF_LOOKUP_ALLOWED} lookups` : '';
	return { text: `SPF flattening: on${lookups} · ${c.last_refreshed_at !== null ? `checked ${timeAgo(c.last_refreshed_at, now)}` : 'not checked yet'}`, tone: st.stale ? 'attention' : 'ok' };
}
