import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { renderApp } from './render';

/** The DNS records section, end to end: a live p=REJECT (any case) is never offered back as p=none. */
const domain = { id: 1, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const now = Math.floor(Date.now() / 1000);
const routes = (current: string) => ({
	'GET /api/domains': { domains: [domain] },
	'GET /api/domains/1/check-summary': {
		domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now, dns_check_attempted_at: now, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
		total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 0,
	},
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: current, cf_managed: true },
	'GET /api/domains/1/onboarding-status': {
		domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: true,
		dmarc: { found: true, has_our_rua: false, current_record: current },
		spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false },
		dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
		routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
	},
	'GET /api/domains/1/rollout-next': { current_policy: 'reject', current_pct: 100, current_testing: false, current_record: current, current_step_index: 4, total_steps: 5, next_step: null, next_step_note: null, dns_preview: null, pass_rate: null, blocked: false, block_reason: null, has_unknown_senders: false, behind_schedule: false, recommended_policy: null, recommended_pct: null },
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
});

describe('DNS records: the recommended record keeps the live policy', () => {
	it.each(['v=DMARC1; p=Reject; rua=mailto:someone@else.test', 'v=DMARC1; p=REJECT; rua=mailto:someone@else.test', 'v=DMARC1; p= reject; rua=mailto:someone@else.test'])('%s', async (current) => {
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{ route: '/domains/1', routes: routes(current) },
		);
		await userEvent.click(await screen.findByRole('button', { name: /^DNS records/ }));
		expect(await screen.findByText('Recommended record')).toBeInTheDocument();
		const offered = screen.getAllByText(/rua=mailto:someone@else\.test,mailto:r@reports\.test/);
		expect(offered.length).toBeGreaterThan(0);
		for (const el of offered) {
			expect(el.textContent).toMatch(/p=\s*reject/i);
			expect(el.textContent).not.toMatch(/p=none/);
		}
	});
});
