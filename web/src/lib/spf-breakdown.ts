// What a person can do by hand about an SPF record that needs more than 10 lookups, from the real breakdown of where the lookups go
// (GET /api/domains/:id/spf-lookups, src/spf/breakdown.ts). Every sentence names a real term of the record; nothing is offered that the numbers do not support.
import { organizationalDomain } from '@ready-set-mail/dns-checks/org-domain';
import { SPF_LOOKUP_LIMIT } from '@ready-set-mail/dns-checks/spf-record';
import { plural } from './spf-flatten';

export interface SpfLookupItem {
	term: string;
	kind: 'include' | 'a' | 'mx' | 'ptr' | 'exists';
	target: string | null;
	cost: number;
	nested: Array<{ target: string; cost: number }>;
}
export type SpfLookupsView = { ok: true; record: string; source: 'published' | 'original'; total: number; items: SpfLookupItem[] } | { ok: false; message: string };

/** One sentence per thing worth trying, most useful first. */
export function byHandTips(v: Extract<SpfLookupsView, { ok: true }>): string[] {
	const tips: string[] = [];
	const over = v.total - SPF_LOOKUP_LIMIT;
	const includes = v.items.filter((i) => i.kind === 'include').sort((a, b) => b.cost - a.cost);
	for (const i of includes.slice(0, 3)) {
		const inside = i.cost - 1;
		const effect = v.total - i.cost <= SPF_LOOKUP_LIMIT ? ` Without it the record needs ${v.total - i.cost}, within the limit.` : '';
		tips.push(`${i.term} costs ${plural(i.cost, 'lookup')}${inside > 0 ? ` (1 for the include and ${inside} inside it)` : ''}. If you no longer send mail through ${i.target}, remove it.${effect}`);
	}
	// Two includes of the same provider: one may already cover what the other adds.
	const byOrg = new Map<string, string[]>();
	for (const i of includes) {
		const org = organizationalDomain(i.target ?? '') ?? i.target ?? '';
		byOrg.set(org, [...(byOrg.get(org) ?? []), i.term]);
	}
	for (const [org, terms] of byOrg) if (terms.length > 1) tips.push(`${terms.join(' and ')} both belong to ${org}. Check in ${org}'s own instructions whether one of them already covers what you use.`);
	const own = v.items.filter((i) => i.kind !== 'include');
	if (own.length) tips.push(`${own.map((i) => i.term).join(', ')} ${own.length === 1 ? 'costs' : 'cost'} 1 lookup each. Listing the addresses of those servers as ip4: or ip6: terms costs none.`);
	if (over > 0 && includes.length > 0 && !includes.some((i) => v.total - i.cost <= SPF_LOOKUP_LIMIT)) {
		tips.push('Removing one include is not enough: you need to remove about ' + plural(over, 'lookup') + '. If all of them are in use, the usual ways out are sending some mail from a subdomain with its own SPF record, or listing a provider\'s addresses instead of its include (SPF flattening does that for you where it is switched on).');
	}
	return tips;
}
