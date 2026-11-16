import { describe, expect, it } from 'vitest';
import { noSpfAtName } from '@ready-set-mail/dns-checks/spf-identity';
import { assessDomain } from '../src/lib/levels';
import { domainVerdict } from '../src/lib/verdict';
import { explain, failingMailFate, failLabel, isFailing, type AuthSource, type NamePolicy } from '../src/lib/reports';

// Subdomain slice (audit 2026-11-15), the statements a person reads. Each cites the standard it rests on.

const src = (over: Partial<AuthSource> = {}): AuthSource => ({
	source_ip: '203.0.113.7', header_from: 'app.example.com', spf_domain: 'cf-bounce.app.example.com', dkim_domain: 'app.example.com', spf_pass: 1, dkim_pass: 1, base_domain: null, org: null, ...over,
});
const live = (over = {}) => ({ domain: 'example.com', sp: null, pct: 100, ...over });

describe('B1: a source whose SPF and DKIM passed but whose mail failed DMARC is failing, and says which identifier did not align', () => {
	it('is failing when the receiver says neither identifier aligned', () => {
		expect(isFailing(src({ dmarc_fail: 1 }))).toBe(true);
		expect(isFailing(src())).toBe(false);
		expect(failLabel(src({ dmarc_fail: 1 }))).toBe('Alignment');
	});
	it('names the return-path domain and the signing domain that did not align, and the fix at the right place (RFC 9989 section 3.2.10.1)', () => {
		const t = explain(src({ header_from: 'example.com', spf_domain: 'bounces.esp.example', dkim_domain: 'esp.example', dmarc_fail: 1, spf_aligned: 0, dkim_aligned: 0 }), 'reject');
		expect(t).toContain('SPF passed for the return-path (MAIL FROM) domain bounces.esp.example');
		expect(t).toContain('DKIM passed for the signing domain d=esp.example');
		expect(t).toContain('not in the same organization as example.com');
		expect(t).toContain('(<selector>._domainkey.<the d= it signs with>)');
	});
	it('under strict alignment the same organization is not enough, and the row says why (section 3.2.10.2)', () => {
		const t = explain(src({ dmarc_fail: 1, spf_aligned: 0, dkim_aligned: 0, dkim_domain: 'mailer.example', aspf: 's' }), 'reject');
		expect(t).toContain('aspf=s');
		expect(t).toContain('identical domain app.example.com');
	});
});

describe('B6: the SPF fix is never "add the provider\'s bounce hostname to your SPF record"', () => {
	it('an unaligned return-path: a custom return-path in the sending service\'s settings, not an include at the From name', () => {
		const t = explain(src({ header_from: 'app.example.com', spf_domain: 'cf-bounce.app.example.com', dkim_pass: 0, dmarc_fail: 1, spf_aligned: 0, dkim_aligned: 0, aspf: 's' }), 'reject');
		expect(t).not.toMatch(/Add include:cf-bounce/);
		expect(t).not.toMatch(/to your SPF record/);
		expect(t).toContain('strict alignment');
	});
	it('a different organization\'s return-path: say it is the service\'s custom return-path (MAIL FROM) setting, and that the From name\'s SPF record cannot help', () => {
		const t = explain(src({ header_from: 'example.com', spf_domain: 'mailchimp.com', dkim_pass: 0, dmarc_fail: 1 }), 'none');
		expect(t).not.toMatch(/Add include:mailchimp\.com/);
		expect(t).toContain('custom return-path (MAIL FROM) domain under example.com');
		expect(t).toContain('SPF is checked at mailchimp.com, not at example.com');
	});
	it('SPF failed but DMARC passes on aligned DKIM: the SPF record to fix is the one at the return-path domain, never at the From name', () => {
		const t = explain(src({ header_from: 'example.com', spf_domain: 'mailchimp.com', spf_pass: 0, dkim_pass: 1, dkim_aligned: 1, spf_aligned: 0 }), 'reject');
		expect(t).not.toMatch(/Add include:/);
		expect(t).toContain('DMARC still passes, because DKIM aligns');
		expect(t).toContain('SPF record of mailchimp.com');
		expect(t).toContain('does not apply to this mail');
	});
});

describe('B5: a subdomain is never said to "inherit" without knowing it has no record of its own', () => {
	it('without the name read: says the subdomain\'s own record, if there is one, decides', () => {
		const t = failingMailFate('reject', live(), 'app.example.com');
		expect(t).not.toMatch(/inherits/);
		expect(t).toContain('We have not read whether it publishes a DMARC record of its own');
		expect(t).toContain('if it does, that record decides');
		expect(t).toContain('p=reject on example.com\'s record applies');
	});
	it('with sp=: names sp= as what applies if the subdomain has no record', () => {
		const t = failingMailFate('reject', live({ sp: 'none' }), 'app.example.com');
		expect(t).toContain('sp=none on example.com\'s record applies to it instead of p=reject');
	});
	it('an invalid sp= is not "ignored, so it inherits p=": receivers do not apply the record as written (section 4.10.1)', () => {
		const t = failingMailFate('reject', live({ invalidSp: 'bogus' }), 'app.example.com');
		expect(t).not.toMatch(/ignored, so it inherits/);
		expect(t).toContain('act as if it said p=none when it has a valid rua=');
	});
	it('with the name read: its own record is the source, stated as such', () => {
		const named: NamePolicy = { status: 'applies', policy: 'reject', tag: 'p', at: 'app.example.com', source: 'own', exists: true, pct: 100 };
		const t = failingMailFate('reject', live(), 'app.example.com', named);
		expect(t).toContain('app.example.com publishes its own DMARC record, which sets p=reject');
		expect(t).not.toMatch(/inherits|no sp= tag/);
	});
	it('with the name read and no record of its own: the tag that applies and where it is', () => {
		const named: NamePolicy = { status: 'applies', policy: 'none', tag: 'sp', at: 'example.com', source: 'organizational', exists: true, pct: 100 };
		const t = failingMailFate('reject', live({ sp: 'none' }), 'news.example.com', named);
		expect(t).toContain('news.example.com has no DMARC record of its own, so sp=none on example.com\'s record applies to it');
		expect(t).toContain('still deliver it');
	});
});

describe('B4: no SPF record at the name', () => {
	const base = { dmarc_policy: 'reject', spf_record: null, dkim_total: 100, dkim_pass: 100, spf_total: 100, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: 1, domain: 'app.example.com' };
	it('without evidence, the statement says what a missing record at the name does and does not mean', () => {
		const a = assessDomain(base);
		const spf = a.findings[0]!;
		expect(spf.status).toBe('missing');
		expect(JSON.stringify(spf.detail)).toContain('return-path');
		expect(JSON.stringify(spf.detail)).not.toContain('Receivers cannot tell which servers may send for you');
	});
	const evidence = { from_messages: 100, from_dkim_aligned: 100, from_spf_at_name: 0, from_unjudged: 0 };
	it('when the reports show none of its mail used the name as its SPF domain, no SPF record is not a fault and does not pull the level down', () => {
		const a = assessDomain({ ...base, ...evidence });
		expect(a.level).toBe(2);
		expect(a.findings[0]).toMatchObject({ status: 'pass', label: 'No SPF record at this name, and none is needed' });
		expect(String(a.findings[0]!.detail)).toBe('No SPF record at app.example.com. In the reports of the last 30 days none of the 100 messages sent as app.example.com used app.example.com as its SPF (return-path) domain, so SPF was checked at other names and a record here would change the result of none of them.');
		expect(a.next).toBeNull();
	});
	it.each([
		['some of its mail used the name as its SPF domain', { ...evidence, from_spf_at_name: 1 }],
		['no mail was sent as the name', { ...evidence, from_messages: 0, from_dkim_aligned: 0 }],
	])('the ladder applies as before when %s', (_why, e) => {
		const a = assessDomain({ ...base, ...e });
		expect(a.level).toBe(0);
		expect(a.findings[0]!.status).toBe('missing');
	});
	it('the owner\'s live case: 40 messages through cf-bounce.app. and 9 unaligned ones elsewhere: no message used the name, so no SPF fault at app.', () => {
		const a = assessDomain({ ...base, from_messages: 49, from_dkim_aligned: 40, from_spf_at_name: 0, from_unjudged: 0 });
		expect(a.findings[0]).toMatchObject({ status: 'pass', label: 'No SPF record at this name, and none is needed' });
		expect(String(a.findings[0]!.detail)).toContain('none of the 49 messages');
	});
	it('the domain verdict stops calling it "no SPF record" when DKIM alignment carries DMARC', () => {
		const now = 1_800_000_000;
		const summary = { ...base, dns_checked_at: now, domain_id: 1, dns_check_attempted_at: now, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 100, pass_messages: 100, fail_messages: 0, ...evidence, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1, spf_lookup_count: null };
		const v = domainVerdict({ id: 1, domain: 'app.example.com', rua_address: 'rua@example.net' }, summary as never, { total: 100, passed: 100, failed: 0, passRate: 100, days: 30 }, null, now);
		expect(v.sentence).not.toMatch(/no SPF record/i);
		expect(v.status).not.toBe('attention');
		const without = domainVerdict({ id: 1, domain: 'app.example.com', rua_address: 'rua@example.net' }, { ...summary, from_spf_at_name: 3 } as never, { total: 100, passed: 100, failed: 0, passRate: 100, days: 30 }, null, now);
		expect(without.sentence).toContain('Public DNS shows no SPF record at app.example.com');
		expect(without.sentence).toContain('return-path');
	});
});

describe('D: no sentence says a From-only name needs SPF', () => {
	it('the shared sentence names the return-path and never "allowed to send as"', () => {
		const t = noSpfAtName('app.example.com');
		expect(t).toContain('return-path');
		expect(t).not.toMatch(/allowed to send as|any server can claim/);
	});
	it('the verdict for a name with no SPF and no DMARC does not claim mail cannot be verified', () => {
		const now = 1_800_000_000;
		const s = { domain_id: 1, domain: 'bare.org', dmarc_policy: null, spf_record: null, dns_checked_at: now, dns_check_attempted_at: now, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null };
		const v = domainVerdict({ id: 1, domain: 'bare.org', rua_address: 'r@x.net' }, s as never, null, null, now);
		expect(v.sentence).not.toMatch(/cannot verify/);
		expect(v.sentence).toContain('no SPF record at bare.org');
	});
});
