import { describe, expect, it } from 'vitest';
import {
	actionTone,
	dkimAdvice,
	dmarcAdvice,
	explain,
	isActive,
	isFailing,
	isOneCheck,
	isUnrecorded,
	isoDay,
	passRate,
	prettyJson,
	protocolStatus,
	relativeTime,
	serviceVia,
	spfAdvice,
	spfStatus,
	splitActive,
	type AuthSource,
} from '../src/lib/reports';

const src = (over: Partial<AuthSource> = {}): AuthSource => ({
	source_ip: '1.2.3.4',
	header_from: 'example.com',
	spf_domain: null,
	dkim_domain: null,
	spf_pass: 0,
	dkim_pass: 0,
	verdict: 'failed',
	base_domain: null,
	org: null,
	...over,
});

describe('explain says what the policy does with spoofed mail', () => {
	it('under p=none the mail is still delivered, never "your DMARC policy will handle it"', () => {
		const t = explain(src(), 'none');
		expect(t).not.toMatch(/will handle it/);
		expect(t).toContain('p=none, so receivers still deliver it');
	});
	it('without a DMARC record it is still delivered', () => expect(explain(src(), 'no-record')).toContain('no DMARC record, so receivers still deliver it'));
	it('quarantine and reject say what they ask receivers to do', () => {
		expect(explain(src(), 'quarantine')).toContain('asks receivers to send it to spam');
		expect(explain(src(), 'reject')).toContain('asks receivers to reject it');
	});
	it('an unknown policy promises nothing', () => {
		const t = explain(src());
		expect(t).not.toMatch(/will handle it|still deliver/);
		expect(t).toContain('could not be read');
	});
});

describe('explain', () => {
	it('says unauthorized when both fail', () => {
		expect(explain(src())).toContain('has no authorization to send as "example.com"');
		expect(explain(src())).toContain('this server');
	});
	it('says where the SPF fix belongs when only SPF fails: at the return-path domain, never an include at the From name', () => {
		const one = { spf_pass: 0, dkim_pass: 1, spf_aligned: 0, dkim_aligned: 1, verdict: 'passed-one' } as const;
		const t = explain(src({ ...one, spf_domain: 'mailchimp.com' }));
		expect(t).toContain('the SPF record of mailchimp.com must authorize this server');
		expect(t).not.toContain('Add include:');
		expect(explain(src(one))).toContain('SPF did not pass for its return-path (MAIL FROM) domain, which the report does not name.');
	});
	it('asks for DKIM when only DKIM fails', () => {
		const t = explain(src({ spf_pass: 1, dkim_pass: 0, spf_aligned: 1, dkim_aligned: 0, verdict: 'passed-one', dkim_domain: 'sendgrid.net' }));
		expect(t).toMatch(/^sendgrid\.net passed DMARC as "example\.com" on SPF alone\./);
		expect(t).toContain('DKIM did not pass for the signing domain d=sendgrid.net.');
	});
	it('falls back to "your domain" without a From', () => {
		expect(explain(src({ header_from: null }))).toContain('send as your domain');
	});
});

describe('explain by the receiver\'s verdict', () => {
	const one = (over: Partial<AuthSource> = {}) => src({ spf_pass: 0, dkim_pass: 1, spf_aligned: 0, dkim_aligned: 1, verdict: 'passed-one', ...over });
	it('passed on DKIM alone, SPF failed at another return-path domain: the SPF record to fix is that domain\'s', () => {
		const t = explain(one({ spf_domain: 'bounces.esp.example', dkim_domain: 'example.com' }));
		expect(t).toContain('passed DMARC as "example.com" on DKIM alone.');
		expect(t).toContain('SPF did not pass for its return-path (MAIL FROM) domain bounces.esp.example, the name where SPF is checked for this mail, so an SPF record at example.com does not apply to it.');
		expect(t).toContain('Worth fixing so there is a backup: if the DKIM signature breaks on the way, this mail fails DMARC.');
	});
	it('the return-path is the From domain itself: its SPF record must authorize the server, and never "does not apply"', () => {
		const t = explain(one({ spf_domain: 'Example.com' }));
		expect(t).toContain('SPF did not pass for example.com, which is also its return-path (MAIL FROM) domain, so the SPF record at example.com must authorize this server');
		expect(t).not.toContain('does not apply');
	});
	it('passed on SPF alone, DKIM not aligned: says why and the fix from the alignment module', () => {
		const t = explain(src({ spf_pass: 1, dkim_pass: 1, spf_domain: 'example.com', dkim_domain: 'esp.example', spf_aligned: 1, dkim_aligned: 0, verdict: 'passed-one' }));
		expect(t).toContain('on SPF alone.');
		expect(t).toContain('DKIM passed for the signing domain d=esp.example, which is not in the same organization as example.com');
		expect(t).toContain('Worth fixing so there is a backup: forwarded mail usually fails SPF, and then this mail fails DMARC.');
	});
	it('not recorded: says so, and nothing about passing or failing', () => {
		expect(explain(src({ verdict: 'not-recorded' }))).toBe("This report was stored before Ready Set Mail kept each receiver's DMARC verdict, so whether this mail passed DMARC is not recorded.");
	});
	it('only a failed verdict is failing; an unknown one never is', () => {
		expect(isFailing(src({ verdict: 'failed' }))).toBe(true);
		expect(isFailing(src({ verdict: 'passed-one' }))).toBe(false);
		expect(isFailing(src({ verdict: undefined, spf_pass: 0, dkim_pass: 0 }))).toBe(false);
		expect(isUnrecorded(src({ verdict: undefined }))).toBe(true);
		expect(isOneCheck(src({ verdict: 'passed-one' }))).toBe(true);
	});
});

describe('serviceVia', () => {
	it('is null when the auth domain equals the From domain', () => {
		expect(serviceVia({ header_from: 'a.com', spf_domain: 'a.com', dkim_domain: null })).toBeNull();
		expect(serviceVia({ header_from: 'a.com', spf_domain: null, dkim_domain: 'b.com' })).toBe('b.com');
	});
});

describe('active / older split', () => {
	const now = new Date('2026-10-22T12:00:00Z');
	it('treats the last two days as active', () => {
		expect(isActive('2026-10-21', now)).toBe(true);
		expect(isActive('2026-10-19', now)).toBe(false);
		expect(isActive('2026-10-10', now)).toBe(false);
		const { active, older } = splitActive([{ last_seen: '2026-10-22' }, { last_seen: '2026-09-01' }], now);
		expect(active).toHaveLength(1);
		expect(older).toHaveLength(1);
	});
});

describe('email check advice', () => {
	it('maps results to statuses', () => {
		expect(protocolStatus(null)).toBe('missing');
		expect(protocolStatus('none')).toBe('missing');
		expect(protocolStatus('pass')).toBe('pass');
		expect(protocolStatus('softfail')).toBe('warn');
		expect(protocolStatus('permerror')).toBe('fail');
		expect(spfStatus('pass', 9)).toBe('warn');
		expect(spfStatus('pass', 3)).toBe('pass');
	});
	it('covers the SPF branches', () => {
		expect(spfAdvice(null, null)).toMatch(/^No SPF record found/);
		expect(spfAdvice('permerror', 12)).toContain('requires 12 DNS lookups');
		expect(spfAdvice('pass', 10)).toContain('at the lookup limit');
		expect(spfAdvice('pass', 10)).toContain('SPF still works');
		expect(spfAdvice('pass', 8)).toContain('close to the lookup limit');
		expect(spfAdvice('pass', 3)).toContain('Uses 3 of 10 DNS lookups.');
		expect(spfAdvice('softfail', null)).toContain('soft-failed');
		expect(spfAdvice('fail', null)).toContain('hard-failed');
		expect(spfAdvice('temperror', null)).toContain('"temperror"');
	});
	it('covers DKIM and DMARC branches', () => {
		expect(dkimAdvice(null)).toContain('No DKIM signature');
		expect(dkimAdvice('fail')).toContain('DKIM failed');
		expect(dmarcAdvice(null, null, null)).toContain('No DMARC record');
		expect(dmarcAdvice('none', null, 'v=DMARC1')).toContain("couldn't evaluate");
		expect(dmarcAdvice('pass', 'reject', 'v=DMARC1')).toContain('maximum protection');
		expect(dmarcAdvice('pass', 'quarantine', 'v=DMARC1')).toContain('upgrading to p=reject');
		expect(dmarcAdvice('pass', 'none', 'v=DMARC1')).toContain('monitoring mode');
		expect(dmarcAdvice('fail', 'none', 'v=DMARC1')).toContain('DMARC failed');
		expect(dmarcAdvice('weird', null, 'v=DMARC1')).toBe('DMARC result: weird. Policy: none.');
	});
});

describe('formatting', () => {
	it('computes ISO days in UTC and pass rates', () => {
		expect(isoDay(1_760_000_000)).toBe('2025-10-09');
		expect(passRate(1, 4)).toBe(25);
		expect(passRate(0, 0)).toBeNull();
	});
	it('relative time', () => {
		const now = Date.parse('2026-10-22T12:00:00Z');
		expect(relativeTime(now / 1000 - 30, now)).toBe('just now');
		expect(relativeTime(now / 1000 - 3 * 3600, now)).toBe('3h ago');
		expect(relativeTime(now / 1000 - 2 * 86400, now)).toBe('2d ago');
	});
	it('"Nd ago" counts whole days: yesterday is 1d, around midnight UTC and across the 24 h / 36 h / 47 h marks', () => {
		const at = (iso: string) => Date.parse(iso);
		const report = at('2026-11-15T00:00:00Z') / 1000; // a report day: yesterday's, starting at midnight UTC
		// seen at any hour on the day after, the report day is "1d ago"
		for (const seen of ['2026-11-16T00:01:00Z', '2026-11-16T12:00:00Z', '2026-11-16T15:30:00Z', '2026-11-16T23:59:00Z']) expect(relativeTime(report, at(seen))).toBe('1d ago');
		expect(relativeTime(report, at('2026-11-16T00:00:00Z'))).toBe('1d ago'); // exactly 24 h
		expect(relativeTime(report, at('2026-11-16T12:00:00Z'))).toBe('1d ago'); // 36 h: rounding said 2d
		expect(relativeTime(report, at('2026-11-16T23:00:00Z'))).toBe('1d ago'); // 47 h
		expect(relativeTime(report, at('2026-11-17T00:00:00Z'))).toBe('2d ago'); // 48 h
		// 23:59 and 00:01 across midnight UTC are minutes apart, not a day
		expect(relativeTime(at('2026-11-15T23:59:00Z') / 1000, at('2026-11-16T00:01:00Z'))).toBe('2m ago');
		expect(relativeTime(at('2026-11-15T00:01:00Z') / 1000, at('2026-11-16T00:00:00Z'))).toBe('23h ago'); // just under a day: never "24h"
		expect(relativeTime(report, at('2026-11-15T00:00:00Z'))).toBe('just now');
		expect(relativeTime(at('2026-11-22T00:00:00Z') / 1000, at('2026-11-16T00:00:00Z'))).toBe('6d from now');
		expect(relativeTime(report, at('2026-11-29T00:00:00Z'))).toBe('2w ago'); // 14 days
		expect(relativeTime(report, at('2026-11-27T00:00:00Z'))).toBe('1w ago'); // 12 days, not 2w
	});
	it('audit helpers', () => {
		expect(actionTone('dns.record_added')).toBe('warning');
		expect(actionTone('mystery')).toBe('neutral');
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyJson('not json')).toBe('not json');
	});
});
