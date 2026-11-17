// Follow-up to PR 161's review: an existing ptr in SPF, an invalid sp= named as written, setup step 4 for a broken DMARC
// record, and the report pages of a hosted customer whose reports cannot come here.
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { dmarcStepsFor, domainVerdict, totalsFromSummary } from '../src/lib/verdict';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { ExplorePage } from '../src/pages/reports/ExplorePage';
import { ReportBrowserPage } from '../src/pages/reports/ReportBrowserPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { renderApp } from './render';
import { noReach } from './reach';

const now = Math.floor(Date.now() / 1000);
const RUA = 'r@reports.test';
const HOSTED = { mode: 'saas', signup_open: true, configured: true, base_domain: null };
const SUM = (o: Record<string, unknown> = {}) =>
	({
		domain_id: 1, domain: 'example.com', dmarc_policy: 'none', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
		total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 1, mta_sts_mode: 'enforce', spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1, report_connect: null, ...o,
	}) as never;
const dom = (o: Record<string, unknown> = {}) => ({ id: 1, domain: 'example.com', dmarc_policy: 'none', rua_address: RUA, parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...o });
const ONB = (dmarc: Record<string, unknown>, spf: Record<string, unknown> = { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false }, rua = RUA) => ({
	domain_id: 1, domain: 'example.com', rua_address: rua, cf_available: true, reach: noReach, dmarc, spf, dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
});
const base = (o: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [dom()] },
	'GET /api/domains/1/check-summary': SUM(),
	'GET /api/domains/summaries': { summaries: [SUM()], next_after: null, window_days: 30 },
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [], one_check: { sources: 0, messages: 0 }, not_recorded: { sources: 0, messages: 0 } },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'PUT /api/domains/1/wizard-state': {},
	'GET /api/domains/1/rollout-next': { __status: 404, body: {} },
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
	'POST /api/spf-lookup-count': { lookup_count: 3 },
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/hosted/statuses': { statuses: {} },
	'GET /api/domains/1/hosted': { enabled: false },
	...o,
});
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const setup = (step: number, routes: Record<string, unknown>, status?: unknown) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
		</Routes>,
		{ route: `/domains/1/setup/${step}`, routes: routes as never, ...(status ? { status: status as never } : {}) },
	);

describe('2. a ptr the live SPF record already has: kept, merge allowed, warned', () => {
	it('the setup wizard offers the merged record with the ptr and says to replace it', async () => {
		const live = 'v=spf1 ptr include:a.test -all';
		setup(2, base({ 'GET /api/domains/1/onboarding-status': ONB({ found: false, has_our_rua: false, current_record: null }, { record: live, lookup_count: 3, flattening_active: false }) }));
		expect(await screen.findByText('Your record uses ptr, which receivers may skip. Replace it with ip4:, ip6: or include: when you can.', {}, { timeout: 8000 })).toBeInTheDocument();
		expect(screen.queryByText('This record cannot be published')).toBeNull();
		expect(await screen.findByRole('button', { name: 'Apply via Cloudflare' })).toBeInTheDocument();
		expect(text()).toContain('v=spf1 include:a.test ptr -all');
	});
});

describe('3. an invalid sp= is named as written', () => {
	it('stored as written (sp=Rejectt): the overview and "Do this next" say sp=Rejectt', () => {
		const s = SUM({ dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: 'none', dmarc_sp: 'Rejectt' });
		const d = { id: 1, domain: 'example.com', rua_address: RUA };
		expect(domainVerdict(d, s, totalsFromSummary(s)).sentence).toBe('At _dmarc.example.com, sp=Rejectt is not a valid policy, so receivers treat the whole record as p=none. Fix sp= or remove it.');
		expect(dmarcStepsFor(d, s, totalsFromSummary(s), null)[0]!.why).toContain('sp=Rejectt');
	});
	it('the domain page shows the same value in "Where it stands" and the DNS records row', { timeout: 20000 }, async () => {
		const rec = `v=DMARC1; p=reject; sp=Rejectt; rua=mailto:${RUA}`;
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				route: '/domains/1',
				routes: base({
					'GET /api/domains/1/check-summary': SUM({ dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: 'none', dmarc_sp: 'Rejectt' }),
					'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: rec, cf_managed: true },
					'GET /api/domains/1/onboarding-status': ONB({ found: true, has_our_rua: true, current_record: rec }),
				}) as never,
			},
		);
		await waitFor(() => expect(text()).toContain('sp=Rejectt is not a valid policy'), { timeout: 8000 });
		expect(text()).not.toContain('sp=rejectt');
	});
});

describe('4. setup step 4 never calls a broken DMARC record configured', () => {
	it('p=reject; sp=bogus with our rua=: the problem, the next step, and no "Reports are configured"', { timeout: 20000 }, async () => {
		const rec = `v=DMARC1; p=reject; sp=bogus; rua=mailto:${RUA}`;
		setup(4, base({
			'GET /api/domains/1/onboarding-status': ONB({ found: true, has_our_rua: true, current_record: rec }),
			'GET /api/domains/1/check-summary': SUM({ dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: 'none', dmarc_sp: 'bogus' }),
		}));
		expect(await screen.findByText('This DMARC record is not applied as written', {}, { timeout: 8000 })).toBeInTheDocument();
		await waitFor(() => expect(text()).toContain('Fix sp= at _dmarc.example.com'), { timeout: 8000 });
		expect(text()).toContain('At _dmarc.example.com, sp=bogus is not a valid policy, so receivers treat the whole record as p=none. Fix sp= or remove it.');
		expect(screen.queryByText('Reports are configured')).toBeNull();
		expect(text()).not.toContain('Reports will start arriving within 24 hours');
	});
	it('without rua=: says the record is broken, not only that it sends no reports here', { timeout: 20000 }, async () => {
		const rec = 'v=DMARC1; p=reject; sp=bogus';
		setup(4, base({
			'GET /api/domains/1/onboarding-status': ONB({ found: true, has_our_rua: false, current_record: rec }),
			'GET /api/domains/1/check-summary': SUM({ dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: null, dmarc_sp: 'bogus', dmarc_rua: 0 }),
		}));
		expect(await screen.findByText('This DMARC record is not applied as written', {}, { timeout: 8000 })).toBeInTheDocument();
		expect(text()).toContain('sp=bogus is not a valid policy and the record has no valid rua=, so receivers ignore the whole record.');
		expect(text()).not.toContain('Your DMARC record exists but does not send reports to Ready Set Mail');
		expect(screen.queryByText('Reports are configured')).toBeNull();
	});
});

describe('5. report pages for a hosted customer whose reports cannot come here', () => {
	const OPERATOR = { can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", refusal_kind: 'operator_only' };
	const routes = base({
		'GET /api/domains': { domains: [dom({ rua_address: '' })] },
		'GET /api/domains/1/check-summary': SUM({ report_connect: OPERATOR, dmarc_rua: null }),
		'GET /api/domains/summaries': { summaries: [SUM({ report_connect: OPERATOR, dmarc_rua: null })], next_after: null, window_days: 30 },
		'GET /api/domains/1/explore': { days: 30, domain: 'example.com', sources: [] },
		'GET /api/reports': { reports: [] },
	});
	for (const [name, el, path, route] of [
		['the explore page', <ExplorePage key="e" />, '/domains/:id/explore', '/domains/1/explore'],
		['the report list', <ReportBrowserPage key="r" />, '/domains/:id/reports', '/domains/1/reports'],
	] as const) {
		it(`${name} uses the domain page's words, never "no report address yet"`, { timeout: 20000 }, async () => {
			renderApp(
				<Routes>
					<Route path={path} element={el} />
				</Routes>,
				{ route, routes: routes as never, status: HOSTED as never },
			);
			expect(await screen.findByText('Reports are not available', {}, { timeout: 8000 })).toBeInTheDocument();
			expect(text()).toContain('so nobody here can confirm that every service sending as it passes');
			expect(text()).not.toContain('no Ready Set Mail report address yet');
			expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
		});
	}
	it('a customer who can connect still gets "Reports not connected yet" with Connect reports', { timeout: 20000 }, async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/explore" element={<ExplorePage />} />
			</Routes>,
			{
				route: '/domains/1/explore',
				routes: base({
					'GET /api/domains': { domains: [dom({ rua_address: '' })] },
					'GET /api/domains/1/check-summary': SUM({ report_connect: { can_connect: true, refusal: null, refusal_kind: null } }),
					'GET /api/domains/1/explore': { days: 30, domain: 'example.com', sources: [] },
					'GET /api/domains/1/report-address': { available: true, reach: noReach, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: true, refusal: null, address: null, connected_at: null, last_report_at: null, counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected', dns: null, parent: null },
				}) as never,
				status: HOSTED as never,
			},
		);
		expect(await screen.findByText('Reports not connected yet', {}, { timeout: 8000 })).toBeInTheDocument();
	});
});
