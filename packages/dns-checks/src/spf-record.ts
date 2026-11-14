/** Pure SPF record helpers for the setup wizard. */

export type SpfQualifier = '~all' | '-all';

/** Every `include:` target in the record, known provider or not, in order. */
export function extractIncludes(record: string): string[] {
	return (record.match(/include:([^\s]+)/g) ?? []).map((m) => m.replace('include:', ''));
}

/** Mechanisms other than version, includes and the final `all` (mx, a, ip4:, ip6:, redirect=…). */
export function extractOtherMechanisms(record: string): string[] {
	return record.split(/\s+/).filter((part) => part !== '' && part !== 'v=spf1' && !part.startsWith('include:') && !/^[~+?-]?all$/i.test(part));
}

const isRedirect = (term: string) => /^redirect=/i.test(term);
const ALL_TERM = /(^|\s)[~+?-]?all(\s|$)/i;

/** True when the record has a `redirect=` modifier. */
export function hasSpfRedirect(record: string | null | undefined): boolean {
	return !!record && record.split(/\s+/).some(isRedirect);
}

/**
 * The one SPF record builder (the setup wizard, the analytics fixes and anything that proposes SPF). `qualifier` null:
 * no `all` mechanism, because the record ends in `redirect=` (RFC 7208 section 6.1: with an `all` mechanism present,
 * `redirect=` is ignored, so adding one would drop every sender the redirected record authorises). A `redirect=` is
 * always written last.
 */
export function buildSpfRecord(includes: string[], qualifier: SpfQualifier | null = '~all', otherMechanisms: string[] = []): string {
	const redirect = otherMechanisms.filter(isRedirect);
	const rest = otherMechanisms.filter((m) => !isRedirect(m));
	return ['v=spf1', ...includes.map((i) => `include:${i}`), ...rest, ...(qualifier ? [qualifier] : []), ...redirect].join(' ');
}

/**
 * The `all` a rebuilt record keeps: `-all` stays `-all` (never weakened), anything else becomes the softfail default
 * (`+all` and `?all` let anyone send). Null for a record that ends in `redirect=` without an `all`: it is complete, and
 * judged by the record it redirects to.
 */
export function existingQualifier(record: string | null): SpfQualifier | null {
	if (record && hasSpfRedirect(record) && !ALL_TERM.test(record)) return null;
	return /(^|\s)-all(\s|$)/i.test(record ?? '') ? '-all' : '~all';
}

/**
 * Normalises what someone typed into the "custom provider" box: drops a pasted `include:` prefix and
 * returns null when it is not a plausible domain name.
 */
export function normalizeCustomInclude(input: string): string | null {
	const v = input.trim().toLowerCase().replace(/^include:/, '');
	return /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?\.[a-z0-9-]{2,}$/.test(v) ? v : null;
}

/** RFC 7208 section 4.6.4: more than this many DNS-querying terms is a permanent error. Exactly this many is within the limit. */
export const SPF_LOOKUP_LIMIT = 10;
/** From this many lookups, one more include may take SPF over the limit. */
export const SPF_LOOKUP_NEAR = 8;

export interface SpfLookupJudgement {
	/** `ok` under SPF_LOOKUP_NEAR, `near` from there up to the limit, `at` exactly the limit (still works), `over` past it (permanent error). */
	level: 'ok' | 'near' | 'at' | 'over';
	/** The check status: only `over` fails. */
	status: 'pass' | 'warn' | 'fail';
	/** Short label, e.g. "At the lookup limit". */
	label: string;
	/** One plain sentence on what the count means for mail. */
	detail: string;
}

/**
 * The one judgement of an SPF lookup count, for every screen and the email check: 10 is within the limit (SPF still
 * works), 11 or more is a permanent error that makes SPF fail for all mail.
 */
export function spfLookupJudgement(count: number): SpfLookupJudgement {
	if (count > SPF_LOOKUP_LIMIT) {
		return {
			level: 'over',
			status: 'fail',
			label: 'Over the lookup limit',
			detail: `Receivers stop at ${SPF_LOOKUP_LIMIT} lookups and treat the record as a permanent error, so SPF fails for all your mail. Remove includes you no longer use, or flatten the record.`,
		};
	}
	if (count === SPF_LOOKUP_LIMIT) {
		return { level: 'at', status: 'warn', label: 'At the lookup limit', detail: 'At the limit, not over it, so SPF still works. One more include would make it fail for all your mail.' };
	}
	if (count >= SPF_LOOKUP_NEAR) {
		return { level: 'near', status: 'warn', label: 'Close to the lookup limit', detail: `One more include may push it over the limit of ${SPF_LOOKUP_LIMIT}, which makes SPF fail for all your mail.` };
	}
	return { level: 'ok', status: 'pass', label: 'Within the lookup limit', detail: `Within the limit of ${SPF_LOOKUP_LIMIT}.` };
}

/** "9 of 10 DNS lookups". */
export const spfLookupCount = (count: number): string => `${count} of ${SPF_LOOKUP_LIMIT} DNS lookups`;
