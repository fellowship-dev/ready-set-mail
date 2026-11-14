import { describe, expect, it } from 'vitest';
import { SPF_LOOKUP_LIMIT, spfLookupJudgement } from '@ready-set-mail/dns-checks/spf-record';
import { assessDomain } from '../src/lib/levels';
import { spfAdvice, spfStatus } from '../src/lib/reports';
import { spfSeverity } from '../src/pages/wizards/setup/steps';

/**
 * One table for the SPF lookup count, RFC 7208 section 4.6.4: 10 is within the limit (SPF still works), 11 is a permanent
 * error. Every screen that judges a count reads the same row: overview level, setup wizard, email-check advice.
 */
const TABLE = [
	{ n: 7, level: 'ok', status: 'pass', severity: 'good', finding: 'pass', broken: false, advice: /Uses 7 of 10 DNS lookups\./ },
	{ n: 8, level: 'near', status: 'warn', severity: 'warning', finding: 'warn', broken: false, advice: /close to the lookup limit/ },
	{ n: 9, level: 'near', status: 'warn', severity: 'warning', finding: 'warn', broken: false, advice: /close to the lookup limit/ },
	{ n: 10, level: 'at', status: 'warn', severity: 'warning', finding: 'warn', broken: false, advice: /at the lookup limit\. At the limit, not over it, so SPF still works/ },
	{ n: 11, level: 'over', status: 'fail', severity: 'error', finding: 'fail', broken: true, advice: /over the lookup limit\. Receivers stop at 10 lookups/ },
] as const;

const summary = (n: number) => ({ dmarc_policy: 'reject', spf_record: 'v=spf1 ~all', dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: 1, spf_lookup_count: n, dmarc_pct: 100 });

describe('SPF lookup count: one judgement everywhere', () => {
	it('has one limit', () => {
		expect(SPF_LOOKUP_LIMIT).toBe(10);
	});

	it.each(TABLE)('$n lookups', (row) => {
		const j = spfLookupJudgement(row.n);
		expect([j.level, j.status]).toEqual([row.level, row.status]);
		// Overview / domain level.
		const a = assessDomain(summary(row.n) as never);
		const spf = a.findings[0]!;
		expect(spf.status).toBe(row.finding);
		if (row.level !== 'ok') expect(spf.detail).toBe(j.detail);
		expect(a.level).toBe(row.broken ? 0 : 2);
		// Setup wizard.
		expect(spfSeverity({ record: 'v=spf1 ~all', lookup_count: row.n, flattening_active: false })).toBe(row.severity);
		// Email check: a passing result with this many lookups.
		expect(spfStatus('pass', row.n)).toBe(row.status);
		expect(spfAdvice('pass', row.n)).toMatch(row.advice);
		// Nothing at or under the limit says it fails or is over.
		if (!row.broken) expect(`${j.label} ${j.detail} ${spfAdvice('pass', row.n)}`).not.toMatch(/over the limit,|at or over|silently drop|Over the lookup limit/);
	});

	it('the email check keeps its permerror branch for a real result', () => {
		expect(spfAdvice('permerror', 12)).toMatch(/permerror — your record requires 12 DNS lookups, exceeding the 10-lookup limit/);
	});
});
