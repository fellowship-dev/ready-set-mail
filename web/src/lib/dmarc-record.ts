/** Pure DMARC record helpers shared by the setup wizard, the graduation wizard and the domain page. */

import { parseDmarcTags, readDmarcTag } from '@ready-set-mail/dns-checks/dmarc-tags';
import { isReportAddress } from '@ready-set-mail/dns-checks/dmarc-next-step';

/**
 * True when `rua` is a usable report address. A domain added before a reports domain was configured has an
 * empty one, and a missing field arrives as undefined: neither may end up in a record as `mailto:`. The one check the
 * agent tools use too (isReportAddress).
 */
export const hasReportAddress = isReportAddress;

// The one RFC 7489 tag parser, shared with the server checks and the daily refresh.
export { parseDmarcTags };
const readTag = readDmarcTag;

/** The record with its first `key` tag rewritten in place (its leading whitespace kept), or null when it has none. */
function rewriteTag(record: string, key: string, value: (old: string) => string): string | null {
	const parts = record.split(';');
	const i = parts.findIndex((part) => readTag(part)?.key === key);
	if (i < 0) return null;
	const part = parts[i] ?? '';
	parts[i] = `${/^\s*/.exec(part)?.[0] ?? ''}${key}=${value(readTag(part)?.value ?? '')}`;
	return parts.join(';');
}

const withoutTrailingSemicolon = (record: string) => record.replace(/[;\s]+$/, '');

/** The address of one rua= entry: no `mailto:`, no `!size` limit, lower-cased (addresses are compared case-insensitively). */
const ruaAddress = (entry: string) => entry.trim().replace(/^mailto:/i, '').replace(/![^,]*$/, '').toLowerCase();

/**
 * Recommended record: keeps every existing tag (other rua= addresses, sp=, fo=, pct=…), sets `p=` to
 * the target and appends our rua= address if it is not already there (in any letter case). An existing `p=` is
 * rewritten in place, never duplicated. Without a usable report address only `p=` changes: the record never gets
 * a `mailto:` with an empty or undefined address.
 */
export function buildRecommendedRecord(current: string | null, policy: string, rua: string | null | undefined): string {
	const ours = hasReportAddress(rua) ? rua.trim() : null;
	if (!current) return ours ? `v=DMARC1; p=${policy}; rua=mailto:${ours}` : `v=DMARC1; p=${policy}`;
	let record = rewriteTag(current, 'p', () => policy) ?? `${withoutTrailingSemicolon(current)}; p=${policy}`;
	if (ours) {
		const have = (parseDmarcTags(record).rua ?? '').split(',').map(ruaAddress);
		if (!have.includes(ours.toLowerCase())) {
			record = rewriteTag(record, 'rua', (old) => `${old},mailto:${ours}`) ?? `${withoutTrailingSemicolon(record)}; rua=mailto:${ours}`;
		}
	}
	return record;
}

/** True when a TXT value is a DMARC record (`v=DMARC1` first); anything else at _dmarc is ignored by receivers. */
export function isDmarcTxt(record: string | null | undefined): boolean {
	return !!record && /^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(record);
}

/**
 * Two records that say the same thing: every tag, names and values compared case-insensitively and without spaces
 * (rua= addresses as a set). `p=Reject` and `p=reject` are the same record, so no no-op change is offered.
 */
export function sameDmarcRecord(a: string | null | undefined, b: string | null | undefined): boolean {
	const norm = (r: string | null | undefined) =>
		Object.entries(parseDmarcTags(r))
			.map(([k, v]) => `${k}=${k === 'rua' || k === 'ruf' ? v.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean).sort().join(',') : v.toLowerCase().replace(/\s+/g, '')}`)
			.sort()
			.join(';');
	return !!a && !!b && norm(a) === norm(b);
}

/**
 * What is wrong with a DMARC record as receivers apply it, in one plain sentence, or null when nothing is: several records
 * at the name (`issue` 'multiple' from the stored read), a TXT that is not DMARC, an invalid p= or an invalid sp=.
 * RFC 7489 section 6.6.3: a record with an invalid p= or sp= is not applied as written; with a valid rua= receivers act
 * as if it said p=none, without one they apply no DMARC.
 */
export function dmarcRecordProblem(record: string | null | undefined, at: string, issue?: string | null): string | null {
	if (issue === 'multiple') return `There are several DMARC records at ${at}, so receivers ignore all of them. Keep one and delete the others.`;
	if (!record) return null;
	if (!isDmarcTxt(record)) return `The TXT record at ${at} is not a DMARC record (it does not start with v=DMARC1), so receivers ignore it.`;
	const p = parseDmarcPolicy(record);
	if (p !== 'none' && p !== 'quarantine' && p !== 'reject') return `The DMARC record at ${at} has no valid p= policy (none, quarantine or reject), so receivers do not apply it as written: with a valid rua= they treat it as p=none, without one they ignore it. Set p= to none, quarantine or reject.`;
	const sp = invalidDmarcSp(record);
	if (sp) return `The DMARC record at ${at} has sp=${sp}, which is not a valid policy, so receivers do not apply it as written: with a valid rua= they treat the whole record as p=none, for the domain and its subdomains; without one they ignore it. Fix sp= or remove it.`;
	return null;
}

/** The `p=` value of a record, lower-cased, or null. */
export function parseDmarcPolicy(record: string | null): string | null {
	const p = parseDmarcTags(record).p;
	return p && /^[a-z]+$/i.test(p) ? p.toLowerCase() : null;
}

type PolicyName = 'none' | 'quarantine' | 'reject';

/** The `sp=` value (subdomain policy) when it is none / quarantine / reject; null when absent, empty or not valid (subdomains then inherit p=). */
export function parseDmarcSp(record: string | null | undefined): PolicyName | null {
	const sp = parseDmarcTags(record).sp?.toLowerCase();
	return sp === 'none' || sp === 'quarantine' || sp === 'reject' ? sp : null;
}

/** The `sp=` value as written when it is present but not a policy (`sp=bogus`); null otherwise. */
export function invalidDmarcSp(record: string | null | undefined): string | null {
	const raw = parseDmarcTags(record).sp;
	return raw && !parseDmarcSp(record) ? raw : null;
}

/** The `pct=` share of mail the policy applies to, 0 to 100. An absent or unreadable tag means 100, as for receivers. */
export function parseDmarcPct(record: string | null | undefined): number {
	const raw = parseDmarcTags(record).pct;
	if (raw === undefined || !/^\d{1,3}$/.test(raw)) return 100;
	return Math.min(100, Number(raw));
}

const STRENGTH: Record<PolicyName, number> = { none: 0, quarantine: 1, reject: 2 };

/** A valid `sp=` weaker than `p=` (so subdomains without their own record are enforced less than the domain), else null. */
export function weakerSubdomainPolicy(record: string | null | undefined): PolicyName | null {
	const p = parseDmarcPolicy(record ?? null);
	const sp = parseDmarcSp(record);
	return sp && (p === 'none' || p === 'quarantine' || p === 'reject') && STRENGTH[sp] < STRENGTH[p] ? sp : null;
}

/**
 * How far a live record enforces: `full` only for p=reject applied to all mail, `partial` for quarantine/reject
 * on part of it (pct below 100), `quarantine` for p=quarantine on all mail, `none` for p=none, `unknown` otherwise.
 */
export function enforcementLevel(record: string | null | undefined): { level: 'full' | 'quarantine' | 'partial' | 'none' | 'unknown'; policy: string | null; pct: number } {
	const policy = parseDmarcPolicy(record ?? null);
	const pct = parseDmarcPct(record);
	if (policy === 'none') return { level: 'none', policy, pct };
	if (policy !== 'quarantine' && policy !== 'reject') return { level: 'unknown', policy, pct };
	if (pct < 100) return { level: 'partial', policy, pct };
	return { level: policy === 'reject' ? 'full' : 'quarantine', policy, pct };
}
