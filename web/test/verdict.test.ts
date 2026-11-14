import { describe, expect, it } from 'vitest';
import { actionsPending, domainActions, type ActionInput } from '../src/lib/actions';
import { summaryFetchedAfterRead } from '../src/pages/domains/DomainDetailPage';
import type { DnsCheck, OnboardingResult } from '../src/lib/domain-queries';
import { getStartedSteps } from '../src/lib/get-started';
import type { DomainCheckSummary } from '../src/lib/types';
import { domainVerdict, totalsFromSummary, workspaceAnswer, type ReportTotals } from '../src/lib/verdict';

const now = Math.floor(Date.now() / 1000);
const RUA = 'r@reports.test';
const domain = { id: 1, domain: 'example.com', rua_address: RUA };
/** A stored summary as a DNS read leaves it: own record p=reject; pct=100, sending reports here, SPF in limits. */
const summary = (o: Partial<DomainCheckSummary> = {}): DomainCheckSummary => ({
	domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok',
	dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0,
	spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 3, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1, ...o,
});
/** 30-day totals stored with the summary: `rate` percent of `total` passed (null: no reports). */
const passing = (rate: number | null, total = 1000): Partial<DomainCheckSummary> =>
	rate === null ? { total_messages: 0, pass_messages: 0, fail_messages: 0 } : { total_messages: total, pass_messages: Math.round((total * rate) / 100), fail_messages: total - Math.round((total * rate) / 100) };
const reports = (passRate: number | null, total = 1000): ReportTotals => ({ total: passRate === null ? 0 : total, passed: passRate === null ? 0 : Math.round((total * passRate) / 100), failed: 0, passRate, days: 30 });
const dns = (record: string | null, o: Partial<DnsCheck> = {}): DnsCheck => ({ found: !!record, has_rua: true, current_record: record, cf_managed: false, ...o });
const onboarding = (o: Partial<OnboardingResult> = {}): OnboardingResult => ({
	domain_id: 1, domain: 'example.com', rua_address: RUA, cf_available: false,
	dmarc: { found: true, has_our_rua: true, current_record: null },
	spf: { record: 'v=spf1 include:_spf.google.com -all', lookup_count: 3, flattening_active: false },
	dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
	...o,
});
/** The domain page's inputs after its live read: SPF and DKIM healthy, the stored summary fresh. */
const input = (o: Partial<ActionInput> = {}): ActionInput => ({ domain, summary: summary(passing(99)), dns: dns('v=DMARC1; p=reject; rua=mailto:r@reports.test'), onboarding: onboarding(), sources: [], ...o });
const keys = (o: Partial<ActionInput>) => domainActions(input(o)).map((a) => `${a.status}:${a.key}`);

// ── One table, both renderers ──────────────────────────────────────────────────────────────────────────────────────────
// Each row is a stored summary (what a DNS read leaves) and the domain's reports address. The overview row
// (domainVerdict) and the domain page (domainActions, after its live read stored the same facts) must give the same
// status and the same next step; the page's first item also names the record it offers.
interface Row {
	name: string;
	dom?: Partial<typeof domain>;
	sum: Partial<DomainCheckSummary>;
	/** Listed parent ids by name (the parent's page link). */
	listed?: Record<string, number>;
	suffixParent?: string;
	status: string;
	level: number | null;
	sentence: RegExp;
	next: string;
	/** The page's first item's why (a part of it). */
	why?: RegExp;
	/** The record the page offers, if any. */
	record?: string;
	link?: string;
}
const sub = (parent: string, p: string, sp: string | null, pct: number, rua: 0 | 1, eff: string) => ({ domain: `www.${parent}`, dmarc_inherited_from: parent, dmarc_policy: eff, dmarc_p: p, dmarc_sp: sp, dmarc_pct: pct, dmarc_rua: rua });
export const TRUTH: Row[] = [
	// Own record
	{ name: 'reject, pct=100, reports pass', sum: passing(99), status: 'verified', level: 2, sentence: /example\.com's own DMARC record sets p=reject, so mail from example\.com that fails DMARC is rejected\.$/, next: 'Nothing to do' },
	{ name: 'reject, no reports yet', sum: passing(null), status: 'verified', level: 2, sentence: /is rejected\.$/, next: 'Nothing to do', why: /Nothing in public DNS needs a change/ },
	{ name: 'reject, pct=10, reports pass', sum: { ...passing(99), dmarc_pct: 10 }, status: 'approval', level: 1, sentence: /sets p=reject at pct=10, so only 10% of mail/, next: 'Raise pct from 10 to 100' },
	{ name: 'reject, pct=10, no reports', sum: { ...passing(null), dmarc_pct: 10 }, status: 'gathering', level: 1, sentence: /pct=10/, next: 'Wait for DMARC reports before raising pct to 100' },
	{ name: 'reject, own sp=none', sum: { ...passing(99), dmarc_sp: 'none' }, status: 'improve', level: 2, sentence: /p=reject/, next: 'Set sp=reject to enforce subdomains too' },
	{ name: 'reject, record tags not read since 0012', sum: { ...passing(99), dmarc_p: null, dmarc_rua: null }, status: 'unknown', level: 2, sentence: /p=reject/, next: 'Check the DMARC record again' },
	{ name: 'reject, 60% passing', sum: passing(60), status: 'attention', level: 2, sentence: /rejected/, next: 'Fix the senders that fail DMARC', why: /likely rejected/ },
	{ name: 'reject, 94.6% passing (not rounded up)', sum: { total_messages: 1000, pass_messages: 946, fail_messages: 54 }, status: 'improve', level: 2, sentence: /rejected/, next: 'Fix the senders that fail DMARC' },
	{ name: 'reject, record does not send reports here', sum: { ...passing(null), dmarc_rua: 0 }, status: 'verified', level: 2, sentence: /rejected/, next: 'Nothing to do' },
	{ name: 'quarantine, 92% passing', sum: { ...passing(92), dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }, status: 'approval', level: 2, sentence: /quarantined, usually to spam/, next: 'Approve moving DMARC to p=reject', link: '/domains/1/dmarc-wizard' },
	{ name: 'quarantine, no reports yet (never Done)', sum: { ...passing(null), dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }, status: 'gathering', level: 2, sentence: /quarantined/, next: 'Wait for DMARC reports before moving to p=reject' },
	{ name: 'M5: quarantine, record lacks the reports address, no reports', sum: { ...passing(null), dmarc_policy: 'quarantine', dmarc_p: 'quarantine', dmarc_rua: 0 }, status: 'improve', level: 2, sentence: /quarantined/, next: 'Add the reports address to your DMARC record', link: '/domains/1/setup/4' },
	{ name: 'quarantine, no reports address', dom: { rua_address: '' }, sum: { ...passing(null), dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }, status: 'improve', level: 2, sentence: /quarantined/, next: 'Connect reports so senders can be confirmed' },
	{ name: 'none, 97% passing', sum: { ...passing(97), dmarc_policy: 'none', dmarc_p: 'none' }, status: 'approval', level: 1, sentence: /sets p=none, so mail from example\.com that fails DMARC is still delivered/, next: 'Approve moving DMARC to p=quarantine' },
	{ name: 'none, 80% passing', sum: { ...passing(80), dmarc_policy: 'none', dmarc_p: 'none' }, status: 'improve', level: 1, sentence: /still delivered/, next: 'Fix the senders that fail DMARC' },
	{ name: 'none, no reports yet', sum: { ...passing(null), dmarc_policy: 'none', dmarc_p: 'none' }, status: 'gathering', level: 1, sentence: /still delivered/, next: 'Wait for DMARC reports before moving to p=quarantine' },
	{ name: 'M6: no reports address, old totals in the window', dom: { rua_address: '' }, sum: { ...passing(99), dmarc_policy: 'none', dmarc_p: 'none' }, status: 'improve', level: 1, sentence: /still delivered/, next: 'Connect reports so senders can be confirmed' },
	{ name: 'no DMARC record', sum: { dmarc_policy: null, dmarc_p: null, dmarc_pct: null, dmarc_rua: null }, status: 'attention', level: 0, sentence: /SPF but no DMARC record/, next: 'Publish a DMARC record at p=none', record: 'v=DMARC1; p=none; rua=mailto:r@reports.test', link: '/domains/1/setup/4' },
	{ name: 'several DMARC records', sum: { dmarc_policy: null, dmarc_issue: 'multiple', dmarc_p: null }, status: 'attention', level: 0, sentence: /several DMARC records/, next: 'Keep one DMARC record at _dmarc.example.com and delete the others' },
	// Inherited from the organizational domain
	{ name: 'M1/Sheffield: parent p=reject; sp=quarantine, no reports address in it', dom: { domain: 'www.sheffield.ac.uk' }, sum: sub('sheffield.ac.uk', 'reject', 'quarantine', 100, 0, 'quarantine'), status: 'improve', level: 2, sentence: /www\.sheffield\.ac\.uk has no DMARC record of its own; sheffield\.ac\.uk's record sets sp=quarantine for its subdomains \(its p=reject applies only to sheffield\.ac\.uk itself\)/, next: 'Add the reports address to the DMARC record at _dmarc.sheffield.ac.uk', why: /before moving to sp=reject at _dmarc\.sheffield\.ac\.uk.*Or publish a DMARC record at _dmarc\.www\.sheffield\.ac\.uk/, record: 'v=DMARC1; p=quarantine; rua=mailto:r@reports.test' },
	{ name: 'M3: parent p=reject; sp=quarantine, reports pass', dom: { domain: 'www.example.org' }, sum: { ...passing(95), ...sub('example.org', 'reject', 'quarantine', 100, 1, 'quarantine') }, listed: { 'example.org': 9 }, status: 'approval', level: 2, sentence: /sets sp=quarantine/, next: 'Set sp=reject at _dmarc.example.org', why: /changing example\.org's p= would not change it.*Or publish a DMARC record at _dmarc\.www\.example\.org with p=reject: it affects only www\.example\.org/, record: 'v=DMARC1; p=reject; rua=mailto:r@reports.test', link: '/domains/9' },
	{ name: 'M3b: parent p=quarantine (no sp), 99% passing', dom: { domain: 'www.example.org' }, sum: { ...passing(99), ...sub('example.org', 'quarantine', null, 100, 1, 'quarantine') }, status: 'approval', level: 2, sentence: /follows p=quarantine from example\.org/, next: 'Add sp=reject at _dmarc.example.org', why: /Changing example\.org's p= to reject would also work, but would also apply to example\.org itself/, record: 'v=DMARC1; p=reject; rua=mailto:r@reports.test' },
	{ name: 'M2: parent p=reject; sp=none, reports pass', dom: { domain: 'www.example.org' }, sum: { ...passing(97), ...sub('example.org', 'reject', 'none', 100, 1, 'none') }, status: 'approval', level: 1, sentence: /sets sp=none for its subdomains/, next: 'Set sp=quarantine at _dmarc.example.org', record: 'v=DMARC1; p=quarantine; rua=mailto:r@reports.test' },
	{ name: 'M2: parent p=reject; sp=none, no reports yet', dom: { domain: 'www.example.org' }, sum: { ...passing(null), ...sub('example.org', 'reject', 'none', 100, 1, 'none') }, status: 'gathering', level: 1, sentence: /sp=none/, next: 'Wait for DMARC reports before moving to sp=quarantine at _dmarc.example.org' },
	{ name: 'UCSC shape: parent p=quarantine; sp=none; pct=0, reports pass', dom: { domain: 'www.ucsc.edu' }, sum: { ...passing(97), ...sub('ucsc.edu', 'quarantine', 'none', 0, 1, 'none') }, status: 'approval', level: 1, sentence: /ucsc\.edu's record sets sp=none at pct=0 for its subdomains \(its p=quarantine applies only to ucsc\.edu itself\), so mail from www\.ucsc\.edu that fails DMARC is still delivered\./, next: 'Set sp=quarantine at _dmarc.ucsc.edu and raise pct from 0 to 100', why: /pct=0 applies to the whole record, so raising it also tightens ucsc\.edu itself/, record: 'v=DMARC1; p=quarantine; rua=mailto:r@reports.test' },
	{ name: 'UCSC as published: no reports address in the parent', dom: { domain: 'www.ucsc.edu' }, sum: sub('ucsc.edu', 'quarantine', 'none', 0, 0, 'none'), status: 'improve', level: 1, sentence: /sp=none/, next: 'Add the reports address to the DMARC record at _dmarc.ucsc.edu', record: 'v=DMARC1; p=none; rua=mailto:r@reports.test' },
	{ name: 'parent pct=10 (p=reject), reports pass', dom: { domain: 'www.example.org' }, sum: { ...passing(99), ...sub('example.org', 'reject', null, 10, 1, 'reject') }, status: 'approval', level: 1, sentence: /follows p=reject at pct=10 from example\.org, so only 10% of mail/, next: 'Raise pct from 10 to 100 at _dmarc.example.org', why: /also applies to example\.org itself and every other subdomain/, record: 'v=DMARC1; p=reject; rua=mailto:r@reports.test' },
	{ name: 'WTO shape: parent p=reject; pct=25, no reports address in it', dom: { domain: 'www.wto.org' }, sum: sub('wto.org', 'reject', null, 25, 0, 'reject'), status: 'improve', level: 1, sentence: /follows p=reject at pct=25 from wto\.org/, next: 'Add the reports address to the DMARC record at _dmarc.wto.org', why: /before raising pct to 100 at _dmarc\.wto\.org/, record: 'v=DMARC1; p=reject; pct=25; rua=mailto:r@reports.test' },
	{ name: 'inherited p=reject at pct=100, reports pass', dom: { domain: 'www.example.org' }, sum: { ...passing(99), ...sub('example.org', 'reject', null, 100, 1, 'reject') }, status: 'verified', level: 2, sentence: /follows p=reject from example\.org, so mail from www\.example\.org that fails DMARC is rejected/, next: 'Nothing to do' },
	{ name: 'inherited p=none, no sp, no reports yet', dom: { domain: 'www.example.org' }, sum: sub('example.org', 'none', null, 100, 1, 'none'), status: 'gathering', level: 1, sentence: /follows p=none/, next: 'Wait for DMARC reports before adding sp=quarantine at _dmarc.example.org' },
	{ name: 'parent record gives no policy', dom: { domain: 'www.example.org' }, sum: { dmarc_policy: null, dmarc_issue: 'invalid', dmarc_inherited_from: 'example.org', dmarc_p: null }, status: 'attention', level: 0, sentence: /_dmarc\.example\.org has no valid p= policy/, next: 'Fix the DMARC record at _dmarc.example.org so it has a valid p= policy', why: /Or publish a DMARC record at _dmarc\.www\.example\.org/ },
	{ name: 'www.gov.uk: listed under gov.uk, a public suffix', dom: { domain: 'www.gov.uk' }, sum: { dmarc_policy: null, dmarc_p: null, dmarc_pct: null, dmarc_rua: null }, suffixParent: 'gov.uk', status: 'attention', level: 0, sentence: /no DMARC record/, next: 'Publish a DMARC record at p=none', why: /gov\.uk is a public suffix, so its DMARC record does not apply to www\.gov\.uk/, record: 'v=DMARC1; p=none; rua=mailto:r@reports.test' },
];

describe('truth table: the overview row and the domain page agree', () => {
	it.each(TRUTH.map((r) => [r.name, r] as const))('%s', (_n, r) => {
		const d = { ...domain, ...r.dom };
		const s = summary({ domain: d.domain, ...r.sum });
		const idByName = new Map(Object.entries(r.listed ?? {}));
		const v = domainVerdict(d, s, totalsFromSummary(s), null, now, { idByName, suffixParent: r.suffixParent ?? null });
		const parentId = s.dmarc_inherited_from ? idByName.get(s.dmarc_inherited_from) : undefined;
		const page = domainActions(input({ domain: d, summary: s, parentId, suffixParent: r.suffixParent ?? null }));
		// Overview row
		expect(v.status).toBe(r.status);
		expect(v.level).toBe(r.level);
		expect(v.sentence).toMatch(r.sentence);
		expect(v.next.label).toBe(r.next);
		if (r.link) expect(v.next.to).toBe(r.link);
		// Domain page: the same first step, status and words
		expect(page[0]).toBeDefined();
		expect(page[0]!.do).toBe(v.next.label);
		expect(page[0]!.status).toBe(v.status);
		if (r.why) expect(page[0]!.why).toMatch(r.why);
		expect(page[0]!.record).toBe(r.record);
	});
});

describe('domainVerdict and workspaceAnswer', () => {
	it('names the scope: public DNS, then reports', () => {
		const v = domainVerdict(domain, summary(), reports(99));
		expect(v).toMatchObject({ status: 'verified', level: 2, checked: 'Checked 1 minute ago' });
		expect(v.evidence).toBe('99% of 1,000 reported messages passed DMARC in the last 30 days.');
		expect(workspaceAnswer([{ name: 'example.com', verdict: v }])).toBe('Done, from public DNS and reports: example.com is verified.');
	});

	it('no pass-rate claim without a current reports address, whatever old totals say', () => {
		const v = domainVerdict({ ...domain, rua_address: '' }, summary({ dmarc_policy: 'none', dmarc_p: 'none' }), reports(99));
		expect(v.evidence).toBe('Reports are not connected for this domain, so nobody has confirmed that every sender passes.');
		expect(v.reportsConfirmed).toBe(false);
		expect(v.status).not.toBe('approval');
	});

	it('a quarantine domain is never Done: its own next step is p=reject', () => {
		const q = domainVerdict(domain, summary({ dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }), reports(null), null, now);
		expect(q.status).not.toBe('verified');
		expect(workspaceAnswer([{ name: 'example.com', verdict: q }])).toMatch(/^Not yet/);
	});

	it('pending ownership proofs are part of the answer', () => {
		expect(workspaceAnswer([], 2)).toBe('Not yet: 2 domains are waiting for proof that they are yours.');
		const v = domainVerdict(domain, summary(), reports(99));
		expect(workspaceAnswer([{ name: 'example.com', verdict: v }], 1)).toBe('Not yet: example.com is verified (public DNS and reports), but 1 domain is waiting for proof that it is yours.');
	});

	it('says it is still checking until every row is known', () => {
		expect(workspaceAnswer([{ name: 'a.com', verdict: null }, { name: 'b.com', verdict: null }])).toBe('Checking where your 2 domains stand…');
	});

	it('the workspace is Done only when every domain is Verified from a current check, and says what it rests on', () => {
		const ago = (d: number) => now - d * 86400;
		const ok = domainVerdict(domain, summary(), reports(99), null, now);
		const dnsOnly = domainVerdict(domain, summary(), reports(null), null, now);
		const partial = domainVerdict(domain, summary({ dmarc_pct: 10 }), reports(99), null, now);
		const failing = domainVerdict(domain, summary({ dns_check_status: 'failed', dns_checked_at: ago(1) }), reports(99), null, now);
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: ok }])).toBe('Done, from public DNS and reports: all 2 domains are verified.');
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: dnsOnly }])).toBe('Done, from public DNS only: all 2 domains are verified.');
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: partial }])).toMatch(/^Not yet\./);
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: failing }])).toMatch(/^Not yet\./);
		expect(workspaceAnswer([{ name: 'a.com', verdict: domainVerdict(domain, summary(), null, null, now) }])).toMatch(/^Not yet/);
	});
});

describe('overview row: checks that are failed, old or missing', () => {
	const ago = (d: number) => now - d * 86400;
	it('the latest check failed after a good one: unknown, from the last good check', () => {
		const v = domainVerdict(domain, summary({ dns_check_status: 'failed', dns_check_attempted_at: now - 60, dns_checked_at: ago(2) }), reports(99), null, now);
		expect(v.status).toBe('unknown');
		expect(v.sentence).toMatch(/^The latest DNS check failed\. From the last good check: public DNS shows/);
		expect(v.next.label).toBe('Open the domain to check it again');
	});

	it('M8: a row never fully checked does not claim a "last good check"', () => {
		const v = domainVerdict(domain, summary({ dns_checked_at: null, dns_check_status: 'failed', spf_lookup_count: 12 }), reports(null), null, now);
		expect(v.checked).toMatch(/No successful check yet/);
		expect(v.sentence).not.toMatch(/last good check/);
		expect(v.sentence).toMatch(/\(From partial reads \(no check has completed yet\); the latest check failed\.\)$/);
	});

	it('a last good check older than 7 days supports no advice: re-check first, whatever the status', () => {
		const old = summary({ dmarc_policy: 'none', dmarc_p: 'none', dns_checked_at: ago(9), dns_check_attempted_at: ago(9) });
		const v = domainVerdict(domain, old, reports(97), null, now);
		expect(v.status).toBe('unknown');
		expect(v.sentence).toMatch(/That was 9 days ago, so it may have changed\./);
		expect(v.next.label).toBe('Open the domain to check it again');
		const attention = domainVerdict(domain, summary({ spf_record: null, dns_checked_at: ago(9) }), reports(null), null, now);
		expect(attention.status).toBe('attention');
		expect(attention.next.label).toBe('Open the domain to check it again');
	});

	it('SPF over ten lookups, no SPF, never checked, does not resolve', () => {
		expect(domainVerdict(domain, summary({ spf_lookup_count: 12 }), reports(99), null, now).next.label).toBe('Bring SPF down to 10 DNS lookups or fewer');
		expect(domainVerdict(domain, summary({ spf_record: null }), reports(null), null, now).next.label).toBe('Publish an SPF record');
		const never = domainVerdict(domain, summary({ dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null, spf_record: null, dmarc_policy: null }), reports(null), null, now);
		expect(never).toMatchObject({ status: 'unknown', level: null });
		expect(never.next.label).toBe('Open the domain to read its records from DNS');
		expect(domainVerdict(domain, summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null), null, now).next.label).toBe('Check the spelling, or remove this domain');
	});
});

describe('domainActions: the live-read parts of Do this next', () => {
	it('a lookup that failed is Unknown with a retry, and never "publish a record"', () => {
		expect(keys({ dns: dns(null, { error: 'timeout' }), onboarding: onboarding({ dns_errors: ['spf: timeout'] }) })).toEqual(['unknown:lookup']);
		const [a] = domainActions(input({ dns: null }));
		expect(a).toMatchObject({ status: 'unknown', retry: true });
		expect(a!.why).toMatch(/Nothing is assumed missing/);
	});

	it('orders by urgency and keeps at most three', () => {
		const k = keys({ summary: summary({ dmarc_policy: null, dmarc_p: null }), onboarding: onboarding({ spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' } }) });
		expect(k).toEqual(['attention:spf-missing', 'attention:dmarc-missing', 'unknown:dkim-unknown']);
	});

	it('SPF over ten lookups needs attention and points at flattening', () => {
		const [a] = domainActions(input({ onboarding: onboarding({ spf: { record: 'v=spf1 include:a include:b ~all', lookup_count: 13, flattening_active: false } }) }));
		expect(a).toMatchObject({ key: 'spf-lookups', status: 'attention', to: '/domains/1/spf-flatten' });
	});

	it('the largest failing source is named next to "Fix the senders"', () => {
		const got = domainActions(input({ summary: summary({ ...passing(80), dmarc_policy: 'none', dmarc_p: 'none' }), sources: [{ source_ip: '198.2.180.1', total: 40, header_from: 'example.com', base_domain: 'mcsv.net', org: 'Mailchimp' }] }));
		expect(got[0]!.why).toMatch(/largest failing source is Mailchimp/);
	});

	it('a domain that does not resolve gets one action', () => {
		expect(keys({ summary: summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }) })).toEqual(['attention:nxdomain']);
	});

	it('p=none is never "nothing to do", whatever the report totals', () => {
		for (const r of [99, 80, null]) expect(keys({ summary: summary({ ...passing(r), dmarc_policy: 'none', dmarc_p: 'none' }) })).not.toContain('verified:done');
	});

	it('nothing is decided until the stored summary after the live read arrives', () => {
		expect(domainActions(input({ summary: undefined }))).toEqual([]);
		expect(actionsPending({ dns: dns(null), onboarding: onboarding(), summary: undefined })).toBe(true);
		expect(actionsPending({ dns: dns(null), onboarding: onboarding(), summary: summary(), summaryFresh: false })).toBe(true);
		expect(keys({ summary: null })).toEqual(['unknown:summary-failed']);
	});

	it('a summary fetched before the live read is not used (DMARC issue, does not resolve)', () => {
		const stale = summary({ dmarc_policy: null, dmarc_issue: 'multiple', dmarc_p: null });
		expect(keys({ summary: stale })).toContain('attention:dmarc-multiple');
		expect(keys({ summary: stale, summaryFresh: false })).not.toContain('attention:dmarc-multiple');
		expect(keys({ summary: summary({ dns_check_status: 'nxdomain' }), summaryFresh: false })).not.toContain('attention:nxdomain');
		expect(summaryFetchedAfterRead(1000, 2000)).toBe(false);
		expect(summaryFetchedAfterRead(2000, 2000)).toBe(true);
		expect(summaryFetchedAfterRead(500, 0)).toBe(true);
	});

	it('a DKIM wildcard is "Can\'t tell from public DNS", never "none of the common selectors"', () => {
		const got = domainActions(input({ summary: summary(passing(80)), onboarding: onboarding({ dkim: { selectors: [], source: 'doh', wildcard: true } }) }));
		const w = got.find((a) => a.key === 'dkim-wildcard')!;
		expect(w.status).toBe('unknown');
		expect(w.why).toMatch(/Can't tell from public DNS/);
	});

	it('DKIM: a selector DNS cannot find is a note while mail passes; revoked keys next to a working one are a note', () => {
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [], source: 'doh' } }) })).toEqual(['verified:done', 'note:dkim-unknown']);
		expect(keys({ summary: summary(passing(80)), onboarding: onboarding({ dkim: { selectors: [], source: 'doh' } }) })).toEqual(['improve:senders', 'unknown:dkim-unknown']);
		const both = onboarding({ dkim: { selectors: [{ name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' }, { name: 'new._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAAB' }], source: 'doh' } });
		expect(keys({ onboarding: both })).toEqual(['verified:done', 'note:dkim-old']);
		const cname = onboarding({ dkim: { selectors: [{ name: 'selector1._domainkey.example.com', record: 'selector1-example-com._domainkey.example.onmicrosoft.com' }, { name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' }], source: 'doh' } });
		expect(keys({ onboarding: cname })).toEqual(['verified:done', 'note:dkim-old']);
	});

	it('M9: only revoked keys at the common selectors while 99% of reports pass is a note, not "Needs attention"', () => {
		const revoked = onboarding({ dkim: { selectors: [{ name: 's._domainkey.example.com', record: 'v=DKIM1; p=' }], source: 'doh' } });
		const got = domainActions(input({ onboarding: revoked }));
		expect(got.map((a) => `${a.status}:${a.key}`)).toEqual(['verified:done', 'note:dkim-revoked']);
		expect(got[1]!.why).toMatch(/your provider signs with another selector/);
		// Without passing reports it is Unknown (another selector may exist), still not "Needs attention".
		expect(keys({ summary: summary(passing(null)), onboarding: revoked })).toEqual(['unknown:dkim-revoked']);
	});
});

describe('getStartedSteps', () => {
	it('adds an ownership step only where ownership must be proven', () => {
		const base = { domains: [], claims: 0, summaries: [], verdicts: [], reports: [] };
		expect(getStartedSteps({ ...base, hosted: false }).map((s) => s.key)).toEqual(['add', 'read', 'publish']);
		expect(getStartedSteps({ ...base, hosted: true }).map((s) => s.key)).toEqual(['add', 'prove', 'read', 'publish']);
	});

	it('a step is done only when the data shows it', () => {
		const s = summary({ dmarc_policy: 'none', dmarc_p: 'none' });
		const v = domainVerdict(domain, s, reports(null));
		const steps = getStartedSteps({ hosted: false, domains: [domain], claims: 0, summaries: [s], verdicts: [v], reports: [reports(null)] });
		expect(steps.map((x) => `${x.key}:${x.state}`)).toEqual(['add:done', 'read:done', 'publish:done', 'reports:waiting']);
	});

	it('a domain that does not resolve is work to do, not "not read yet"', () => {
		const ok = domainVerdict(domain, summary(), reports(null), null, now);
		const nx = { ...domain, id: 2, domain: 'nope.example' };
		const gone = domainVerdict(nx, summary({ domain: 'nope.example', dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null), null, now);
		const steps = getStartedSteps({ hosted: false, domains: [domain, nx], claims: 0, summaries: [summary(), summary()], verdicts: [ok, gone], reports: [reports(null), reports(null)] });
		expect(steps.find((x) => x.key === 'publish')).toMatchObject({ state: 'todo', detail: '1 of 2 domains publish both.', action: { label: 'Fix nope.example', to: '/domains/2/settings' } });
	});
});

describe('slots for hosted help (PR 142)', () => {
	it('offers a help prompt only where a person may be stuck', () => {
		expect(domainVerdict(domain, summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null)).help).toEqual({ lead: 'Sure this is the right name?', about: 'about example.com', priority: 50 });
		expect(domainVerdict(domain, summary({ dns_check_status: 'failed' }), reports(null)).help).toEqual({ lead: 'DNS checks keep failing?', about: 'about example.com', priority: 50 });
		expect(domainVerdict(domain, summary(), reports(99)).help).toBeNull();
	});

	it('reports-not-connected follows an empty report address', () => {
		expect(domainVerdict({ ...domain, rua_address: '' }, summary(), reports(null)).reportsNotConnected).toBe(true);
		expect(domainVerdict(domain, summary(), reports(null)).reportsNotConnected).toBe(false);
	});
});
