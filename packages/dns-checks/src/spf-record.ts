/** Pure SPF record helpers for the setup wizard and the apply route. */

import { isSpfRecord, parseSpfTerms } from './spf-terms';

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
	// With an `all` written, a redirect= is ignored by receivers (RFC 7208 section 6.1): it is left out, so the record means the
	// same and is one the apply route accepts (validateSpfRecord refuses both together).
	return ['v=spf1', ...includes.map((i) => `include:${i}`), ...rest, ...(qualifier ? [qualifier] : redirect)].join(' ');
}

const MECHANISM_NAMES: ReadonlySet<string> = new Set(['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists']);
const NEEDS_VALUE: ReadonlySet<string> = new Set(['include', 'ip4', 'ip6', 'exists']);
const MODIFIER_NAME = /^[a-z][a-z0-9._-]*$/;
/** Longer than any sensible record, short enough that a pasted blob is refused. */
export const MAX_SPF_RECORD_LENGTH = 2048;

/** A dotted-quad IPv4 address, each part 0-255 without leading zeros. */
function isIp4(s: string): boolean {
	const parts = s.split('.');
	return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

/** An IPv6 address in RFC 4291 text form: up to 8 hex groups, at most one `::`, optionally ending in an IPv4 address. */
function isIp6(s: string): boolean {
	if (!/^[0-9a-f:.]+$/i.test(s) || s.split('::').length > 2) return false;
	let tail = s;
	let extra = 0;
	const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		if (!isIp4(v4[2]!)) return false;
		tail = v4[1]!.endsWith('::') ? v4[1]! : v4[1]!.slice(0, -1);
		extra = 2;
	}
	const [head, rest] = tail.split('::');
	const groups = (x: string | undefined) => (x ? x.split(':') : []);
	const all = [...groups(head), ...groups(rest)];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
	const count = all.length + extra;
	return rest === undefined ? count === 8 : count <= 7;
}

/** `ip4:` / `ip6:` value that is not an address with an optional prefix length in range. */
export function ipProblem(name: 'ip4' | 'ip6', value: string): boolean {
	const [addr, prefix, ...more] = value.split('/');
	if (more.length) return true;
	const max = name === 'ip4' ? 32 : 128;
	if (prefix !== undefined && !(/^(0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= max)) return true;
	return !(name === 'ip4' ? isIp4(addr ?? '') : isIp6(addr ?? ''));
}

/**
 * THE SPF record rule: why a record must not be published, in a plain sentence, or null when it may. The setup wizard asks
 * it before offering Apply or Copy, and POST /api/domains/:id/apply-spf refuses what it refuses, so nothing the wizard
 * offers is refused by the server and nothing the server refuses is offered. Checked on the trimmed record (publish that
 * same text): printable ASCII without quotes or backslashes, at most MAX_SPF_RECORD_LENGTH characters, starting with
 * v=spf1; every term a known mechanism (with a value where one is required) or a modifier with a value; redirect= and
 * exp= at most once; and complete: exactly one `all`, last among the mechanisms, or no `all` and a redirect= (RFC 7208
 * section 6.1: with an `all` present the redirect is ignored, so both together are refused). `+all` and `?all` are refused
 * (they let any server send), as are ptr (RFC 7208 section 5.5: do not use) and ip4:/ip6: values that are not addresses
 * with a prefix in range (a permanent error for every message). The lookup cost is judged apart (spfLookupJudgement).
 *
 * `live`: the record published now. A ptr term it already has may stay (a provider can still be added to a record that uses
 * ptr; spfPtrWarning says to replace it); adding a ptr is always refused. Without `live`, every ptr is refused.
 */
export function validateSpfRecord(input: string, live?: string | null): string | null {
	const record = input.trim();
	const kept = new Set(live && isSpfRecord(live) ? ptrTerms(live) : []);
	if (!isSpfRecord(record)) return 'SPF record must start with v=spf1';
	if (record.length > MAX_SPF_RECORD_LENGTH || /[^\x20-\x7e]/.test(record) || /["\\]/.test(record)) return `SPF record must be printable text without quotes or backslashes, at most ${MAX_SPF_RECORD_LENGTH} characters`;
	const terms = parseSpfTerms(record);
	const seen = new Map<string, number>();
	for (const t of terms) {
		if (t.kind === 'modifier') {
			if (!MODIFIER_NAME.test(t.name) || !t.value) return `SPF record is not valid: "${t.raw}" is not a valid modifier`;
			seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
			continue;
		}
		if (!MECHANISM_NAMES.has(t.name)) return `SPF record is not valid: "${t.raw}" is not an SPF mechanism`;
		if (NEEDS_VALUE.has(t.name) && !t.value) return `SPF record is not valid: "${t.raw}" needs a value`;
		if ((t.name === 'ip4' || t.name === 'ip6') && ipProblem(t.name, t.value!)) return `SPF record is not valid: "${t.raw}" is not a valid ${t.name === 'ip4' ? 'IPv4' : 'IPv6'} address or prefix`;
		if (t.name === 'ptr' && !kept.has(t.raw.toLowerCase())) return 'SPF record must not use ptr: RFC 7208 says not to, and receivers may skip it. List the sending servers with ip4:, ip6: or include: instead.';
	}
	for (const m of ['redirect', 'exp']) if ((seen.get(m) ?? 0) > 1) return `SPF record is not valid: ${m}= appears more than once`;
	const mechanisms = terms.filter((t) => t.kind === 'mechanism');
	const alls = mechanisms.filter((t) => t.name === 'all');
	if (alls.length > 1) return 'SPF record has more than one all mechanism: anything after the first all is never evaluated. Keep one, at the end.';
	const allIndex = mechanisms.findIndex((t) => t.name === 'all');
	const redirect = seen.has('redirect');
	if (allIndex >= 0 && redirect) return 'SPF record has both an all mechanism and redirect=: receivers ignore redirect= when all is present. Keep one of them.';
	if (allIndex >= 0) {
		if (mechanisms[allIndex]!.qualifier === '+') return 'SPF record must not use +all: it lets any server send as this domain. Use -all or ~all.';
		if (mechanisms[allIndex]!.qualifier === '?') return 'SPF record must not use ?all: neutral protects nothing. Use -all or ~all.';
		if (allIndex !== mechanisms.length - 1) return 'SPF record must end with its all mechanism: anything after all is never evaluated';
		return null;
	}
	return redirect ? null : 'SPF record must end with an all mechanism or a redirect= modifier';
}

/** The record's ptr terms as written, lower-cased (`ptr`, `ptr:example.com`, `-ptr`). */
function ptrTerms(record: string): string[] {
	return parseSpfTerms(record.trim()).filter((t) => t.kind === 'mechanism' && t.name === 'ptr').map((t) => t.raw.toLowerCase());
}

export const SPF_PTR_WARNING = 'Your record uses ptr, which receivers may skip. Replace it with ip4:, ip6: or include: when you can.';

/** The plain warning for a record that keeps a ptr it already had, or null when it has none. */
export function spfPtrWarning(record: string | null | undefined): string | null {
	return record && isSpfRecord(record) && ptrTerms(record).length > 0 ? SPF_PTR_WARNING : null;
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
 * works), 11 or more is a permanent error that makes SPF fail for all mail. `flatten: false` where the person is not offered SPF flattening: the sentence names
 * the by-hand way only.
 */
export function spfLookupJudgement(count: number, opts: { flatten?: boolean } = {}): SpfLookupJudgement {
	if (count > SPF_LOOKUP_LIMIT) {
		return {
			level: 'over',
			status: 'fail',
			label: 'Over the lookup limit',
			detail: `Receivers stop at ${SPF_LOOKUP_LIMIT} lookups and treat the record as a permanent error, so SPF fails for all your mail. Remove includes you no longer use${opts.flatten === false ? '' : ', or flatten the record'}.`,
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
