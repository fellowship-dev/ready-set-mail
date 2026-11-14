import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { getRecommendations } from '../src/lib/pdf/recommendations';
import { dmarcPolicyLabel } from '../src/lib/pdf/report';
import type { DomainCheckSummary, OnboardingStatus } from '../src/lib/types';
import { RadioCard } from '../src/components/wizard/RadioCard';
import { AnalyticsPage } from '../src/pages/analytics/AnalyticsPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { renderApp } from './render';

const summary = (over: Partial<DomainCheckSummary> = {}): DomainCheckSummary => ({
	domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all',
	dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null, dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: null,
	total_messages: 1000, pass_messages: 990, fail_messages: 10,
	dkim_total: 1000, dkim_pass: 990, spf_total: 1000, spf_pass: 990, mta_sts_enabled: 1, mta_sts_mode: 'enforce', ...over,
});

describe('item 7: an unchecked policy is not "monitor only"', () => {
	const ctx = { domain: { id: 1, domain: 'example.com', rua_address: 'r@reports.test' }, hosted: null };
	it('null policy never read: unknown, never "none"', () => {
		const recs = getRecommendations(summary({ dmarc_policy: null }), ctx);
		expect(recs.some((r) => r.severity === 'critical')).toBe(false);
		expect(recs.some((r) => /"none"|monitor only/.test(r.message))).toBe(false);
		expect(recs.some((r) => /has not been read from DNS yet/.test(r.message))).toBe(true);
	});
	it('a real p=none is named as p=none', () => {
		const now = Math.floor(Date.now() / 1000);
		const recs = getRecommendations(summary({ dmarc_policy: 'none', dns_checked_at: now, dns_check_status: 'ok', dmarc_p: 'none', dmarc_pct: 100, dmarc_sp: null, dmarc_rua: 1 } as never), ctx);
		expect(recs.some((r) => /p=none/.test(r.message))).toBe(true);
	});
	it('the PDF policy column says "Not checked yet" only when it was not checked', () => {
		expect(dmarcPolicyLabel({ dmarc_policy: null, dmarc_issue: null, dns_checked_at: null }).label).toBe('Not checked yet');
		expect(dmarcPolicyLabel({ dmarc_policy: null, dmarc_issue: null, dns_checked_at: 1 }).label).toBe('No record found');
		expect(dmarcPolicyLabel({ dmarc_policy: null, dmarc_issue: 'invalid', dns_checked_at: 1 }).label).toBe('Invalid record');
		expect(dmarcPolicyLabel({ dmarc_policy: 'reject', dmarc_issue: null, dns_checked_at: 1, dmarc_pct: 25 }).label).toBe('reject at pct=25');
		expect(dmarcPolicyLabel({ dmarc_policy: 'reject', dmarc_issue: null, dns_checked_at: 1, dmarc_inherited_from: 'example.com' }).label).toBe('reject (inherited)');
	});
});

describe('item 8: no reports domain is "Not configured", not "Missing"', () => {
	const status = (auth: { found: boolean; record_name: string | null }): OnboardingStatus => ({
		domain_id: 7, domain: 'example.com', rua_address: 'r@reports.example.com', cf_available: true,
		dmarc: { found: true, has_our_rua: true, current_record: 'v=DMARC1; p=none; rua=mailto:r@reports.example.com', auth_record: auth },
		spf: { record: 'v=spf1 -all', lookup_count: 1, flattening_active: false },
		dkim: { selectors: [], source: 'doh' },
		routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null, null_sender_spf: true, null_sender_dmarc: true },
	});
	const step = (auth: { found: boolean; record_name: string | null }) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
			</Routes>,
			{
				route: '/domains/7/setup/4',
				routes: {
					'GET /api/domains': { domains: [{ id: 7, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 }] },
					'GET /api/domains/7/onboarding-status': status(auth),
					'GET /api/domains/7/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'not_started', routing: 'not_started' },
					'PUT /api/domains/7/wizard-state': {},
					'GET /api/zones': { zones: [] },
				},
			},
		);

	it('no reports domain: neutral "Not configured" row, no "Missing" and no failure styling', async () => {
		step({ found: false, record_name: null });
		const row = (await screen.findByText('Authorization record')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'neutral');
		expect(row).toHaveTextContent('Not configured');
		expect(row).toHaveTextContent('No reports domain is configured');
		expect(screen.queryByText('Missing')).toBeNull();
	});

	it('a reports domain whose record is absent is still "Missing"', async () => {
		step({ found: false, record_name: 'example.com._report._dmarc.reports.example.com' });
		const row = (await screen.findByText('Authorization record')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'missing');
		expect(row).toHaveTextContent('Missing');
	});
});

describe('item 11b: the workspace readiness table has the sideways-scroll cue', () => {
	it('labels the overflow and puts a hairline on the edge that hides columns', async () => {
		renderApp(<AnalyticsPage />, {
			routes: {
				'GET /api/analytics': {
					days: 30, totals: { messages: 1910, passed: 1610, failed: 300, pass_rate: 84.3, days_with_reports: 20 }, trend: [], senders: [], sender_count: 0, fixes: [],
					domains: [{ domain_id: 1, domain: 'acme.com', dmarc_policy: 'none', messages: 1910, pass_rate: 84.3, readiness: { status: 'blocked', headline: 'Not safe to move to quarantine yet', next: null, policy_source: 'stored' } }],
				},
			},
		});
		const region = await screen.findByRole('region', { name: 'Enforcement readiness by domain' });
		const cue = within(region.parentElement as HTMLElement).getByText('Scroll sideways to see every column.');
		expect(cue).toHaveClass('sm:hidden');
		expect(region).not.toHaveClass('border-r-control');
		Object.defineProperty(region, 'clientWidth', { configurable: true, value: 343 });
		Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 720 });
		fireEvent.scroll(region);
		await waitFor(() => expect(region).toHaveClass('border-r-control'));
		expect(cue).not.toHaveClass('sm:hidden');
	});
});

describe('item 11c: the RadioCard control is 20px', () => {
	it('is size-5 (not size-4) and offset to centre on the title line', () => {
		renderApp(<RadioCard name="n" value="v" checked={false} onChange={() => {}} title="Cloudflare" />);
		return waitFor(() => {
			const radio = screen.getByRole('radio');
			expect(radio).toHaveClass('size-5');
			expect(radio).not.toHaveClass('size-4');
			expect(radio).toHaveClass('mt-0.5');
		});
	});
});
