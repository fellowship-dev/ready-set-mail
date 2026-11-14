import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { FixList } from '../src/components/analytics/FixList';
import { TrendChart } from '../src/components/analytics/TrendChart';
import { DailyChart } from '../src/components/domain/DailyChart';
import { domainActions } from '../src/lib/actions';
import { offeredDmarcRecord } from '../src/lib/dmarc-coverage';
import { reportsRefusalOf } from '../src/lib/dmarc-step';
import { getRecommendations } from '../src/lib/pdf/recommendations';
import { WHO, dmarcStepsFor, domainVerdict, nextPolicyGate, totalsFromSummary } from '../src/lib/verdict';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { renderApp } from './render';

const now = Math.floor(Date.now() / 1000);
const RUA = 'r@reports.test';
const HOSTED = { mode: 'saas', signup_open: true, configured: true, base_domain: null } as never;
const SUM = (o: Record<string, unknown> = {}) =>
	({
		domain_id: 1, domain: 'example.com', dmarc_policy: 'none', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
		total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 1, mta_sts_mode: 'enforce', spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1, report_connect: null, ...o,
	}) as never;
const rc = (kind: 'operator_only' | 'unavailable' | 'ownership' | 'hosted_records' | null, refusal: string | null) => ({ can_connect: kind === null, refusal, refusal_kind: kind });
const OPERATOR = "On this server, only the operator's workspaces can connect reports.";
const OWNERSHIP = (d: string) => `Ownership of ${d} is not proven in this workspace. Remove it and add it again to prove that you control it, then connect reports.`;
const dom = (id: number, name: string, o: Record<string, unknown> = {}) => ({ id, domain: name, dmarc_policy: 'none', rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...o });
const ONB = (dmarc: Record<string, unknown>, spf = { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false }, rua = RUA) => ({
	domain_id: 1, domain: 'example.com', rua_address: rua, cf_available: true, dmarc, spf, dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
});
const pageRoutes = (o: Record<string, unknown>) => ({
	'GET /api/domains': { domains: [dom(1, 'example.com', { rua_address: RUA })] },
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/rollout-next': { __status: 404, body: {} },
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
	...o,
});
const page = (routes: Record<string, unknown>, status?: never) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', routes: routes as never, ...(status ? { status } : {}) },
	);
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

describe('B. reports refused per domain: the truth table (overview row, domain page, wizard, PDF)', () => {
	const policies = [
		{ p: 'none', pct: 100, next: 'move to p=quarantine' },
		{ p: 'quarantine', pct: 50, next: 'raise pct to 100' },
		{ p: 'quarantine', pct: 100, next: 'move to p=reject' },
		{ p: 'reject', pct: 50, next: 'raise pct to 100' },
		{ p: 'reject', pct: 100, next: null },
	] as const;
	const refusals = [
		{ name: 'operator only', c: rc('operator_only', OPERATOR) },
		{ name: 'no intake on this server', c: rc('unavailable', 'This server does not receive DMARC reports.') },
		{ name: 'ownership not proven', c: rc('ownership', OWNERSHIP('example.com')) },
		{ name: 'hosted records', c: rc('hosted_records', 'Reports for this domain come through its hosted records.') },
		{ name: 'can connect', c: rc(null, null) },
	];
	const d = { id: 1, domain: 'example.com', rua_address: '' };
	for (const pol of policies) {
		for (const r of refusals) {
			it(`${r.name} × p=${pol.p} pct=${pol.pct}`, () => {
				const s = SUM({ dmarc_policy: pol.p, dmarc_p: pol.p, dmarc_pct: pol.pct, dmarc_rua: null, report_connect: r.c });
				const refusal = reportsRefusalOf(s);
				const v = domainVerdict(d, s, totalsFromSummary(s), null, undefined, { hostedMode: true, reportsRefusal: refusal });
				const steps = dmarcStepsFor(d, s, totalsFromSummary(s), null, null, null, refusal);
				const actions = domainActions({ domain: d, dns: { found: true, has_rua: false, current_record: `v=DMARC1; p=${pol.p}`, cf_managed: false } as never, onboarding: ONB({ found: true, has_our_rua: false, current_record: `v=DMARC1; p=${pol.p}` }, undefined, '') as never, summary: s, sources: [], reportsRefusal: refusal });
				const pdf = getRecommendations(s, { domain: d, hosted: null, hostedMode: true, reportsRefusal: refusal });
				if (!pol.next) {
					// At reject on all mail: protection is in place, so it is a note at most, and nobody is sent anywhere.
					expect(v.status).toBe('verified');
					expect(actions[0]!.do).toBe('Nothing to do');
					return;
				}
				// Below reject at pct=100 the gap is "Worth fixing", and the step is for You.
				expect(v.status).toBe('improve');
				expect(v.next.who).toBe(WHO.you);
				const want = r.c.refusal_kind === 'operator_only' || r.c.refusal_kind === 'unavailable'
					? `Check each service that sends as example.com, then ${pol.next}`
					: r.c.refusal_kind === 'ownership'
						? 'Prove that you control example.com, then connect reports'
						: r.c.refusal_kind === 'hosted_records'
							? 'Connect reports through the hosted records'
							: 'Connect reports so senders can be confirmed';
				expect(v.next.label).toBe(want);
				expect(steps[0]!.do).toBe(want);
				expect(actions[0]!.do).toBe(want);
				if (r.c.refusal_kind === 'ownership' || r.c.refusal_kind === 'hosted_records') expect(steps[0]!.why).toContain(r.c.refusal!);
				if (r.c.refusal_kind === 'operator_only' || r.c.refusal_kind === 'unavailable') {
					expect(steps[0]!.why).toMatch(/^Reports are not available for this domain, so nobody here can confirm/);
					expect(steps[0]!.why).not.toMatch(/on this plan yet/);
				}
				// The PDF keeps it among the warnings, in the same words.
				expect(pdf.some((x) => x.severity === 'warning' && x.message.includes(want))).toBe(true);
			});
		}
	}

	it('the wizard is told to ask for the check, not to block', () => {
		const s = SUM({ dmarc_rua: null, report_connect: rc('operator_only', OPERATOR) });
		const g = nextPolicyGate({ domain: 'example.com', rua_address: '' }, s, null, 'none', reportsRefusalOf(s));
		expect(g).toMatchObject({ ready: false, step: { key: 'check-senders', who: 'you' } });
	});
});

describe('1. the overview and the domain page decide each domain from its own answer', () => {
	const domains = [dom(1, 'legacy.example'), dom(2, 'proven.example')];
	const summaries = [
		SUM({ domain_id: 1, domain: 'legacy.example', dmarc_rua: null, report_connect: rc('ownership', OWNERSHIP('legacy.example')) }),
		SUM({ domain_id: 2, domain: 'proven.example', dmarc_rua: null, report_connect: rc(null, null) }),
	];
	const base = {
		'GET /api/domains': { domains },
		'GET /api/domains/summaries': { summaries, next_after: null, window_days: 30 },
		'GET /api/hosted/config': { enabled: true, reports: true, records: false },
		'GET /api/hosted/statuses': { statuses: {} },
		'GET /api/domains/1/hosted': { enabled: false },
		'GET /api/domains/2/hosted': { enabled: false },
		'GET /api/domain-claims': { claims: [] },
		'GET /api/claims': { claims: [] },
	};
	it('overview rows', async () => {
		renderApp(<OverviewPage />, { status: HOSTED, routes: base as never });
		await screen.findAllByText(/proven\.example/, {}, { timeout: 4000 });
		await waitFor(() => expect(text()).toContain('Prove that you control legacy.example, then connect reports'));
		expect(text()).toContain('Connect reports so senders can be confirmed');
	});
});

describe('3. the overview says what happened to reports that were not counted', () => {
	it('from the batch row, not "none arrived"', () => {
		const note = 'AUTHSERV_ID and AUTHSERV_HEADER are not both set, so no inbound report can be counted: every report is stored but left out of the numbers.';
		const s = SUM({ counting_note: note, uncounted: { reports: 3, messages: 30, latest_at: now, unknown: 3, unauthenticated: 0, by_reporter: [] } });
		const v = domainVerdict({ id: 1, domain: 'example.com', rua_address: RUA }, s, totalsFromSummary(s), null);
		expect(v.evidence).toContain(note);
		expect(v.evidence).not.toMatch(/No DMARC reports in the last/);
	});
	it('the overview page renders it, and "Receive DMARC reports" is not "None yet"', async () => {
		const note = 'AUTHSERV_ID and AUTHSERV_HEADER are not both set, so no inbound report can be counted: every report is stored but left out of the numbers.';
		renderApp(<OverviewPage />, {
			routes: {
				'GET /api/domains': { domains: [dom(1, 'example.com', { rua_address: RUA })] },
				'GET /api/domains/summaries': { summaries: [SUM({ counting_note: note })], next_after: null, window_days: 30 },
				'GET /api/hosted/config': { enabled: false },
				'GET /api/domain-claims': { claims: [] },
				'GET /api/claims': { claims: [] },
			} as never,
		});
		await waitFor(() => expect(text()).toContain(note));
		expect(text()).not.toMatch(/No DMARC reports in the last 30 days/);
		expect(text()).not.toMatch(/None yet\. Receivers send them/);
	});
});

describe('4. empty charts and fix lists ask emptyReportsState first', () => {
	const v = { uncounted: { reports: 3, messages: 30, latest_at: now, unknown: 3, unauthenticated: 0, by_reporter: [] } };
	const msg = '3 reports from senders we do not recognise are not counted.';
	it('DailyChart', async () => {
		renderApp(<DailyChart domainId={1} stats={[]} days={7} visibility={v} />);
		expect(await screen.findByText('No counted reports in this window')).toBeInTheDocument();
		expect(text()).toContain(msg);
		expect(text()).not.toContain('Daily bars appear when the first one arrives');
	});
	it('TrendChart', async () => {
		renderApp(<TrendChart trend={[]} days={30} visibility={v} />);
		expect(await screen.findByText('No counted reports in this window')).toBeInTheDocument();
		expect(text()).toContain(msg);
	});
	it('FixList', async () => {
		renderApp(<FixList fixes={[]} messages={0} visibility={v} />);
		expect(await screen.findByText('No counted reports for this period')).toBeInTheDocument();
		expect(text()).toContain(msg);
		expect(text()).not.toContain('none arrived in this window');
	});
	it('without anything left out they still say none arrived', async () => {
		renderApp(<FixList fixes={[]} messages={0} visibility={{}} />);
		expect(await screen.findByText('No reports for this period')).toBeInTheDocument();
	});
});

describe('5. the Reports section never says the whole domain is done', () => {
	it('with 11 SPF lookups, "Do this next" leads with SPF and the Reports section speaks for DMARC only', async () => {
		const rec = `v=DMARC1; p=reject; rua=mailto:${RUA}`;
		const s = SUM({ dmarc_policy: 'reject', dmarc_p: 'reject', spf_lookup_count: 11, total_messages: 100, pass_messages: 100 });
		page(pageRoutes({
			'GET /api/domains/1/check-summary': s,
			'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-11-10', total: 100, passed: 100, failed: 0 }] },
			'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: rec, cf_managed: true },
			'GET /api/domains/1/onboarding-status': ONB({ found: true, has_our_rua: true, current_record: rec }, { record: 'v=spf1 include:a.test -all', lookup_count: 11, flattening_active: false }),
		}));
		expect(await screen.findByText('Bring SPF down to 10 DNS lookups or fewer', {}, { timeout: 3000 })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: /^Reports/ }));
		expect(await screen.findByText('DMARC needs no change')).toBeInTheDocument();
		expect(text()).toContain('Nothing about DMARC in public DNS and 100 reported messages needs a change.');
		expect(text()).not.toMatch(/Nothing in public DNS and 100 reported messages needs a change/);
	});
});

describe('6. the SPF step offers only a record the shared rule accepts', () => {
	it('two redirect= terms: says why, and offers no Apply', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
			</Routes>,
			{
				route: '/domains/1/setup/2',
				routes: pageRoutes({ 'GET /api/domains/1/onboarding-status': ONB({ found: false, has_our_rua: false, current_record: null }, { record: 'v=spf1 redirect=x.test redirect=y.test include:a.test', lookup_count: 3, flattening_active: false }), 'PUT /api/domains/1/wizard-state': {}, 'POST /api/spf-lookup-count': { lookup_count: 3 } }) as never,
			},
		);
		expect(await screen.findByText('This record cannot be published')).toBeInTheDocument();
		expect(text()).toContain('The record has more than one redirect=, so receivers treat it as an error.');
		expect(screen.queryByRole('button', { name: 'Apply via Cloudflare' })).toBeNull();
	});
});

describe('the DMARC records row says what receivers do with a broken record', () => {
	const row = async (rec: string, sum: Record<string, unknown> = {}) => {
		page(pageRoutes({
			'GET /api/domains/1/check-summary': SUM({ dmarc_policy: 'reject', dmarc_p: 'reject', ...sum }),
			'GET /api/domains/1/dns-check': { found: true, has_rua: rec.includes(RUA), current_record: rec, cf_managed: true },
			'GET /api/domains/1/onboarding-status': ONB({ found: true, has_our_rua: rec.includes(RUA), current_record: rec }),
		}));
		await userEvent.click(await screen.findByRole('button', { name: /^DNS records/ }));
		await screen.findAllByText(/DMARC record/);
	};
	it('several records: receivers ignore all of them, never "Published"', { timeout: 20000 }, async () => {
		await row(`v=DMARC1; p=reject; rua=mailto:${RUA}`, { dmarc_policy: null, dmarc_p: null, dmarc_pct: null, dmarc_issue: 'multiple' });
		await waitFor(() => expect(text()).toContain('DMARC record: FailThere are several DMARC records at _dmarc.example.com, so receivers ignore all of them. Keep one and delete the others.'));
		expect(text()).not.toContain('Published, and aggregate reports are sent to Ready Set Mail.');
		expect(text()).toContain('The DMARC record is not applied as published, so reports may not arrive.');
		expect(text()).not.toContain('DNS record detected. Reports will start arriving soon.');
	});
	it('p=rejected is not a policy: no "Pass", and nothing offered', async () => {
		await row(`v=DMARC1; p=rejected; rua=mailto:${RUA}`);
		expect(await screen.findByText(/has no valid p= policy \(none, quarantine or reject\), so receivers do not apply it as written/)).toBeInTheDocument();
		expect(screen.queryByText('Recommended record')).toBeNull();
	});
	it('a record that differs only in letter case needs no change', async () => {
		await row(`v=DMARC1; p=Reject; rua=mailto:${RUA}`);
		expect(await screen.findByText('Published, and aggregate reports are sent to Ready Set Mail.')).toBeInTheDocument();
		expect(screen.queryByText('Recommended record')).toBeNull();
	});
	it('a TXT that is not DMARC, an invalid p= or an invalid sp= gets no offer', () => {
		expect(offeredDmarcRecord('google-site-verification=abc', { kind: 'own' }, RUA)).toBeNull();
		expect(offeredDmarcRecord('v=DMARC1; p=rejected', { kind: 'own' }, RUA)).toBeNull();
		expect(offeredDmarcRecord('v=DMARC1; p=reject; sp=bogus', { kind: 'own' }, RUA)).toBeNull();
		expect(offeredDmarcRecord('v=DMARC1; p=Reject', { kind: 'own' }, RUA)).toBe(`v=DMARC1; p=reject; rua=mailto:${RUA}`);
	});
});
