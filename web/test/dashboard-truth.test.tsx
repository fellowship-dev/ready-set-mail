import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { domainActions } from '../src/lib/actions';
import { assessDomain } from '../src/lib/levels';
import { WHO, dmarcStepsFor, domainVerdict, totalsFromSummary } from '../src/lib/verdict';
import { DomainDetailPage, summaryFreshness } from '../src/pages/domains/DomainDetailPage';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, renderApp, type Handler } from './render';

const now = Math.floor(Date.now() / 1000);
const D = { id: 1, domain: 'example.com', dmarc_policy: 'quarantine', rua_address: 'r@reports.test', parent_id: null as number | null, created_at: 1, alerts_enabled: 1, is_default: 0 };
const current = 'v=DMARC1; p=quarantine; rua=mailto:r@reports.test';
const SUM = {
	domain_id: 1, domain: 'example.com', dmarc_policy: 'quarantine', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 100, pass_messages: 97, fail_messages: 3, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'quarantine', dmarc_sp: null, dmarc_rua: 1,
};
const ONB = {
	domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: false, dmarc: { found: true, has_our_rua: true, current_record: current },
	spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false }, dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
};
const WIZ = { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' };
const routes = (over: Record<string, unknown | Handler> = {}) => ({
	'GET /api/domains': { domains: [D] },
	'GET /api/domains/1/check-summary': SUM,
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-11-10', total: 100, passed: 97, failed: 3 }] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': WIZ,
	'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: current, cf_managed: false },
	'GET /api/domains/1/onboarding-status': ONB,
	'GET /api/domains/1/rollout-next': fail(404),
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
	...over,
});
const page = (r: Record<string, unknown | Handler>, opts: Parameters<typeof renderApp>[1] = {}) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', routes: r, ...opts },
	);
/** A JSON response whose body arrives after `ms`. */
const later = (body: unknown, ms = 80) => () =>
	new Response(new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close(); }, ms); } }), { headers: { 'content-type': 'application/json' } });
/** A response that never finishes. */
const never = () => () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('3. subdomain badges say only what was read', () => {
	it('a child with no stored policy is "not checked yet", never p=none; the parent text uses the live policy', async () => {
		const child = { ...D, id: 2, domain: 'mail.example.com', parent_id: 1, dmarc_policy: null };
		page(routes({
			'GET /api/domains': { domains: [{ ...D, dmarc_policy: null }, child] },
			'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: 'v=DMARC1; p=quarantine', cf_managed: false },
			'GET /api/domains/summaries': { summaries: [SUM, { ...SUM, domain_id: 2, domain: 'mail.example.com', dmarc_policy: null, dns_checked_at: null, dmarc_p: null, dmarc_pct: null, dmarc_rua: null }], next_after: null },
		}));
		await userEvent.click(await screen.findByRole('button', { name: /^Subdomains/ }));
		expect(await screen.findByText('DMARC not checked yet')).toBeInTheDocument();
		expect(screen.queryByText('p=none')).toBeNull();
		expect(screen.getByText(/inherit p=quarantine, which may be too permissive/)).toBeInTheDocument();
		expect(screen.queryByText(/inherit p=none/)).toBeNull();
	});
});

describe('5. "no reports" only when none arrived', () => {
	const uncounted = { reports: 2, messages: 10, latest_at: now, unknown: 2, unauthenticated: 0, by_reporter: [] };
	it('the domain page says reports arrived but were not counted', async () => {
		page(routes({ 'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [], uncounted } }));
		expect((await screen.findAllByText(/No counted reports yet\. 2 reports from senders we do not recognise are not counted\./)).length).toBeGreaterThan(0);
		expect(screen.queryByText('No reports in the last 7 days.')).toBeNull();
	});
	it('the verdict (overview, PDF) says so too', () => {
		const s = { ...SUM, total_messages: 0, pass_messages: 0, fail_messages: 0, uncounted } as never;
		const v = domainVerdict(D, s, totalsFromSummary(s), null);
		expect(v.evidence).toContain('2 reports from senders we do not recognise are not counted.');
		expect(v.evidence).not.toMatch(/No DMARC reports in the last/);
	});
});

describe('6. a failed refetch never leaves "Reading…" forever', () => {
	it('summaryFreshness: a failed refetch after the live read is stale, not waiting', () => {
		expect(summaryFreshness(100, 200, { isFetching: false, isError: true })).toBe('stale');
		expect(summaryFreshness(100, 200, { isFetching: true, isError: false })).toBe('waiting');
		expect(summaryFreshness(300, 200, { isFetching: false, isError: false })).toBe('fresh');
	});
	it('shows the last known steps, marked as possibly out of date, with a retry', async () => {
		let n = 0;
		page(routes({ 'GET /api/domains/1/check-summary': () => (++n === 1 ? SUM : fail(429)), 'GET /api/domains/1/onboarding-status': later(ONB) }));
		const note = await screen.findByText(/These steps come from the last stored check and may be out of date/, {}, { timeout: 3000 });
		expect(within(note.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		expect(screen.queryByText(/Reading this domain's records from public DNS/)).toBeNull();
	});
});

describe('7. a hosted domain is never judged as self-managed while its hosted status loads', () => {
	it('the domain page waits, like the overview', async () => {
		page(routes({ 'GET /api/hosted/config': { enabled: true, reports: false, records: true }, 'GET /api/domains/1/hosted': never() }));
		expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument();
		await pause(300);
		expect(screen.getByText('Loading what is known about this domain…')).toBeInTheDocument();
		expect(screen.queryByText(/example\.com's own DMARC record sets p=quarantine/)).toBeNull();
	});
});

describe('8. the parent is the overview\'s', () => {
	it('a parent chain that loops gives no parent on the domain page, as on the overview', async () => {
		page(routes({ 'GET /api/domains': { domains: [{ ...D, parent_id: 2 }, { ...D, id: 2, domain: 'other.example', parent_id: 1 }] } }));
		expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument();
		await screen.findByRole('button', { name: /^DNS records/ });
		expect(screen.queryByRole('button', { name: /^Parent domain/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /^Subdomains/ })).toBeNull();
	});
});

describe('9. one voice on the domain page', () => {
	it('the Reports section renders the shared step, never "Ready to enforce" beside it', async () => {
		page(routes({
			'GET /api/domains/1/check-summary': { ...SUM, dmarc_rua: 0 },
			'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: 'v=DMARC1; p=quarantine; rua=mailto:other@else.test', cf_managed: false },
		}));
		await userEvent.click(await screen.findByRole('button', { name: /^Reports/ }));
		await waitFor(() => expect(screen.getAllByText('Add the reports address to your DMARC record')).toHaveLength(2));
		expect(screen.queryByText(/Ready to enforce|Fully protected|safely move to reject/)).toBeNull();
	});

	it('the DMARC wizard offers the next policy only when the shared rule does, and says what it waits on', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
			</Routes>,
			{
				route: '/domains/1/dmarc-wizard',
				routes: routes({
					'GET /api/domains': { domains: [{ ...D, dmarc_policy: 'none' }] },
					'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=none; rua=mailto:r@reports.test', cf_managed: false },
					'GET /api/domains/1/check-summary': { ...SUM, dmarc_policy: 'none', dmarc_p: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0 },
				}),
			},
		);
		expect(await screen.findByText('Not ready for p=quarantine yet')).toBeInTheDocument();
		expect(screen.getByText(/Waits on:/).closest('p')).toHaveTextContent('Waits on: Wait for DMARC reports before moving to p=quarantine');
		expect(screen.queryByText('Step 1: switch to quarantine')).toBeNull();
		expect(screen.queryByText(/New record/)).toBeNull();
	});
});

describe('B. hosted plan where this workspace cannot connect reports', () => {
	const hostedDomain = { ...D, rua_address: '' };
	const rows = [
		{ name: 'p=none', s: { dmarc_policy: 'none', dmarc_p: 'none', dmarc_pct: 100 } },
		{ name: 'p=quarantine', s: { dmarc_policy: 'quarantine', dmarc_p: 'quarantine', dmarc_pct: 100 } },
		{ name: 'p=reject pct=50', s: { dmarc_policy: 'reject', dmarc_p: 'reject', dmarc_pct: 50 } },
		{ name: 'p=reject', s: { dmarc_policy: 'reject', dmarc_p: 'reject', dmarc_pct: 100 } },
	];
	it.each(rows)('$name: connecting reports is nobody\'s step; overview and domain page agree', ({ name, s }) => {
		const sum = { ...SUM, ...s, dmarc_rua: null, total_messages: 0, pass_messages: 0, fail_messages: 0 } as never;
		const v = domainVerdict(hostedDomain, sum, totalsFromSummary(sum), null, undefined, { hostedMode: true, reportsAvailable: false });
		expect(v.next.label).not.toMatch(/Connect reports/);
		expect(v.next.who).toBe(WHO.nobody);
		const steps = dmarcStepsFor(hostedDomain, sum, totalsFromSummary(sum), null, null, null, false);
		expect(steps.some((x) => x.key === 'connect-reports')).toBe(false);
		const actions = domainActions({ domain: hostedDomain, dns: { found: true, has_rua: false, current_record: 'v=DMARC1', cf_managed: false } as never, onboarding: { ...ONB, rua_address: '' } as never, summary: sum, sources: [], reportsAvailable: false });
		expect(actions.some((a) => /Connect reports/.test(a.do) || a.who === WHO.you)).toBe(false);
		if (name === 'p=reject') {
			expect(v.status).toBe('verified');
			expect(actions[0]!.do).toBe('Nothing to do');
		} else {
			expect(v.next.label).toBe('Nothing to do until reports are available');
			expect(actions[0]!.do).toBe(v.next.label);
			expect(actions[0]!.why).toMatch(/Reports are not available on this plan yet.*waits on them/);
		}
		// Where reports can be connected, connecting stays the step for you.
		const open = domainVerdict(hostedDomain, sum, totalsFromSummary(sum), null, undefined, { hostedMode: true });
		if (name !== 'p=reject') expect(open.next.label).toBe('Connect reports so senders can be confirmed');
	});
});

describe('C and A. the setup wizard', () => {
	const setup = (step: number, onb: unknown, extra: Record<string, unknown> = {}) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
			</Routes>,
			{ route: `/domains/1/setup/${step}`, routes: { ...routes(), 'GET /api/domains/1/onboarding-status': onb, 'PUT /api/domains/1/wizard-state': {}, ...extra } },
		);

	it('C: the DMARC step for a p=none domain gives the shared next step toward quarantine', async () => {
		setup(4, { ...ONB, dmarc: { found: true, has_our_rua: true, current_record: 'v=DMARC1; p=none; rua=mailto:r@reports.test' } }, {
			'GET /api/domains/1/check-summary': { ...SUM, dmarc_policy: 'none', dmarc_p: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0 },
		});
		expect(await screen.findByText('Next: Wait for DMARC reports before moving to p=quarantine')).toBeInTheDocument();
	});

	it('A: a redirect-only SPF record is complete: no all is proposed (it would void the redirect)', async () => {
		const { calls } = setup(2, { ...ONB, spf: { record: 'v=spf1 redirect=icann.org', lookup_count: 4, flattening_active: false } });
		expect(await screen.findByText(/handled by the record it redirects to/)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/redirect=icann\.org ~all|redirect=icann\.org -all/);
		expect(calls.some((c) => c.path === '/api/spf-lookup-count')).toBe(false);
	});
});

describe('levels: a partly enforced policy says what happens to the rest', () => {
	const base = { spf_record: 'v=spf1 -all', dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: 1, spf_lookup_count: 1, dmarc_pct: 50 };
	it('p=reject at pct=50: the rest is quarantined, not delivered', () => {
		const f = assessDomain({ ...base, dmarc_policy: 'reject' } as never).findings.find((x) => /partly enforced/.test(String(x.label)))!;
		expect(String(f.detail)).toMatch(/one step more leniently, so it is quarantined, usually to spam/);
		expect(String(f.detail)).not.toMatch(/still delivered/);
	});
	it('p=quarantine at pct=50: the rest is delivered', () => {
		const f = assessDomain({ ...base, dmarc_policy: 'quarantine' } as never).findings.find((x) => /partly enforced/.test(String(x.label)))!;
		expect(String(f.detail)).toMatch(/one step more leniently, so it is still delivered/);
	});
});
