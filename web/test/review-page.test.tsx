// C2, review and Apply, after Cloudflare returns (hosted): what exists now, what will be written, one Apply, then the dashboard.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberFocusDomain, reviewDone } from '../src/lib/first-run';
import { NOT_CHANGED, ReviewPage } from '../src/pages/setup/ReviewPage';
import { fail, me, renderApp } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const HOSTED = { mode: 'saas' as const, signup_open: true, configured: true, has_domain: true };
const domainRow = (id: number, name: string, extra = {}) => ({ id, domain: name, dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, cf_account_id: 'acc1', verified_via: 'cloudflare', ...extra });
const account = { id: 'c1', label: 'Brightwave Studio', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'acc1', cf_account_name: 'Brightwave Studio', scopes: [], zones: [] };
const conns = { connections: [account], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true };
const RUA = 'rua=mailto:rua@reports.readysetmail.com';

const write = (over: Record<string, unknown> = {}) => ({
	id: 'dmarc:7', domain: 'brightwave-mail.com', zone: 'brightwave-mail.com', type: 'TXT', name: '_dmarc.brightwave-mail.com',
	content: `v=DMARC1; p=quarantine; pct=50; ${RUA}`, action: 'update', before: 'v=DMARC1; p=quarantine; pct=50',
	reason: 'Adds the address that receives your reports. Your policy stays as it is.', ...over,
});
const plan = (writes: unknown[], notWritten: unknown[] = [], id = 'plan-1') => ({ plan_id: id, steps: [{ key: 'dmarc', writes, satisfied: (writes as Array<{ action: string }>).every((w) => w.action === 'none') }], not_written: notWritten });

function Where() {
	return <output data-testid="where">{useLocation().pathname}</output>;
}
function open(opts: { routes?: Record<string, unknown>; role?: 'owner' | 'member'; domains?: unknown[]; claims?: unknown[] } = {}) {
	rememberFocusDomain('ws_default', 'brightwave-mail.com');
	return renderApp(
		<>
			<Routes>
				<Route path="/setup/review" element={<ReviewPage />} />
				<Route path="/" element={<p>dashboard</p>} />
				<Route path="/setup" element={<p>s4</p>} />
			</Routes>
			<Where />
		</>,
		{
			route: '/setup/review',
			role: opts.role ?? 'owner',
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: opts.domains ?? [domainRow(7, 'brightwave-mail.com')], pending_claims: opts.claims ?? [] },
				'GET /api/cloudflare/connections': conns,
				'POST /api/onboarding/dns-plan': plan([write()]),
				'POST /api/onboarding/dns-apply': { results: [{ id: 'dmarc:7', ok: true, verified: true, reports: 'connected' }] },
				'PUT /api/domains/7/wizard-state': { ok: true },
				'POST /api/onboarding/first-check': { results: [{ domain_id: 7, stored: true }] },
				...opts.routes,
			},
		},
	);
}
const where = () => screen.getByTestId('where').textContent;

describe('C2: what will be written', () => {
	it('shows the change with what is there now, what it will be, why, and the one Apply', async () => {
		open({ domains: [domainRow(7, 'brightwave-mail.com'), ...[8, 9, 10, 11].map((i) => domainRow(i, `d${i}.example`))] });
		expect(await screen.findByRole('heading', { name: '1 change to brightwave-mail.com' })).toBeInTheDocument();
		expect(screen.queryByText(/Step \d of \d/)).toBeNull(); // one counter across the flow, or none: none
		expect(screen.getByText(/Connected to Cloudflare account Brightwave Studio\./)).toBeInTheDocument();
		const card = screen.getByTestId('change-dmarc:7');
		expect(card).toHaveTextContent('DMARC · TXT _dmarc · Update');
		expect(card).toHaveTextContent('Now: v=DMARC1; p=quarantine; pct=50');
		expect(card).toHaveTextContent(`After Apply: v=DMARC1; p=quarantine; pct=50; ${RUA}`);
		expect(card.querySelector('mark')).toHaveTextContent(RUA); // the added part is the thing the eye finds
		expect(card).toHaveTextContent('Adds the address that receives your reports. Your policy stays as it is.');
		expect(screen.getByText(NOT_CHANGED)).toBeInTheDocument();
		expect(NOT_CHANGED).toBe('Not changed: SPF and DKIM. They depend on which services send your mail. Once reports show who sends, we suggest the exact records.');
		expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeInTheDocument();
		expect(screen.getByText('Also in Brightwave Studio: 4 more domains, added and watched. Nothing was written to them.')).toBeInTheDocument();
		// nothing here is for pasting
		expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
		expect(screen.getByRole('link', { name: 'Hand setup to a teammate →' })).toHaveAttribute('href', '/setup/hand-off?domain=brightwave-mail.com'); // owner, hosted
	});

	it('a new record says it is new, starts the policy where the server starts it, and counts as one change', async () => {
		open({ routes: { 'POST /api/onboarding/dns-plan': plan([write({ action: 'create', before: null, content: `v=DMARC1; p=none; ${RUA}`, reason: 'Starts in monitoring mode: nothing is blocked while reports come in.' })]) } });
		const card = await screen.findByTestId('change-dmarc:7');
		expect(card).toHaveTextContent('DMARC · TXT _dmarc · New');
		expect(card).toHaveTextContent(`Will be: v=DMARC1; p=none; ${RUA}`);
		expect(card).not.toHaveTextContent('Now:');
		expect(card).toHaveTextContent('Starts in monitoring mode: nothing is blocked while reports come in.');
	});

	it('Apply writes the plan it showed, then goes straight to the dashboard and says the review is done', async () => {
		const { calls } = open();
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Apply 1 change' }));
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/onboarding/dns-apply')?.body).toEqual({ domain_ids: [7], step: 'dmarc', plan_id: 'plan-1' });
		expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/domains/7/wizard-state')).toBe(true);
		expect(reviewDone('ws_default')).toBe(true);
		expect(localStorage.getItem('rsm_review_done:ws_default')).toBe('applied');
		expect(calls.some((c) => c.path === '/api/onboarding/first-check')).toBe(true); // public DNS read and stored for the dashboard
		expect(where()).toBe('/');
	});

	it('Cloudflare refusing a write says so, writes nothing as far as we know, and offers to try again', async () => {
		open({ routes: { 'POST /api/onboarding/dns-apply': { results: [{ id: 'dmarc:7', ok: false, error: 'Authentication error (10000)' }] } } });
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Apply 1 change' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Cloudflare refused the change: Authentication error (10000). Nothing was written.');
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		expect(where()).toBe('/setup/review');
		expect(reviewDone('ws_default')).toBe(false);
	});

	it('a plan that changed since it was shown is shown again before anything is written', async () => {
		let n = 0;
		open({
			routes: {
				'POST /api/onboarding/dns-apply': () => (n++ === 0 ? { __status: 409, body: { code: 'plan_changed', error: 'plan changed', plan: plan([write({ content: `v=DMARC1; p=quarantine; pct=100; ${RUA}`, before: 'v=DMARC1; p=quarantine; pct=100' })], [], 'plan-2') } } : { results: [{ id: 'dmarc:7', ok: true, verified: true }] }),
			},
		});
		const { calls } = { calls: [] as never[] };
		void calls;
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Apply 1 change' }));
		expect(await screen.findByText('Cloudflare changed since you looked. Review again.')).toBeInTheDocument();
		expect(screen.getByTestId('change-dmarc:7')).toHaveTextContent('Now: v=DMARC1; p=quarantine; pct=100');
		expect(where()).toBe('/setup/review');
		await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});

	it('"Skip for now" leaves without writing and does not bring the review back', async () => {
		const { calls } = open();
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Skip for now' }));
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/onboarding/dns-apply')).toBe(false);
		expect(localStorage.getItem('rsm_review_done:ws_default')).toBe('skipped');
	});

	it('nothing to change: says so and goes to the dashboard, no Apply', async () => {
		open({ routes: { 'POST /api/onboarding/dns-plan': plan([write({ action: 'none', before: null })]) } });
		expect(await screen.findByRole('heading', { name: 'brightwave-mail.com needs no change' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
		await userEvent.setup().click(screen.getByRole('button', { name: 'Go to the dashboard' }));
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});

	it('a record the plan cannot touch is listed in the server\'s words, not hidden', async () => {
		open({ routes: { 'POST /api/onboarding/dns-plan': plan([], [{ domain: 'brightwave-mail.com', what: 'DMARC', step: 'dmarc', reason: 'It has two DMARC records.' }]) } });
		expect(await screen.findByText(/Not written for brightwave-mail\.com: DMARC\. It has two DMARC records\./)).toBeInTheDocument();
	});

	it('a plan that cannot be read says so with a retry, and the dashboard is one click away', async () => {
		open({ routes: { 'POST /api/onboarding/dns-plan': fail(502, 'Cloudflare is not answering') } });
		expect(await screen.findByText('Could not read the records in Cloudflare')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Go to the dashboard' })).toBeInTheDocument();
	});

	it('a domain that is not in the connected account: said plainly, with the way back', async () => {
		open({ domains: [], claims: [{ id: 5, domain: 'brightwave-mail.com', status: 'pending', txt_name: 'x', txt_value: 'y', created_at: 1, last_checked_at: null, last_error: null }] });
		expect(await screen.findByText("brightwave-mail.com isn't in the Cloudflare account you connected. Connect the account that has it, or add the records yourself.")).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to your domain' })).toHaveAttribute('href', '/setup');
	});

	it('a member cannot apply anything: back to the dashboard', async () => {
		open({ role: 'member' });
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});
});

describe('C2 honest about reports, in both HOSTED_CONNECT_REPORTS cases', () => {
	it('reports allowed (the owner, or "all"): the record carries the hosted report address', async () => {
		open();
		const card = await screen.findByTestId('change-dmarc:7');
		expect(card).toHaveTextContent('rua=mailto:rua@reports.readysetmail.com');
		expect(screen.queryByTestId('reports-note')).toBeNull();
	});

	it('reports not allowed for this workspace ("owner" and this is not the owner): a DMARC record with no report address, and the server\'s plain sentence above it', async () => {
		const sentence = 'Reports are not connected for this workspace. Only the person who runs this service can connect reports for now. The records below are written without a report address.';
		open({
			routes: {
				'POST /api/onboarding/dns-plan': plan([write({ action: 'create', before: null, content: 'v=DMARC1; p=none', reason: 'Starts in monitoring mode: nothing is blocked.' })], [{ what: 'Report address', step: 'dmarc', reason: sentence }]),
			},
		});
		const card = await screen.findByTestId('change-dmarc:7');
		expect(card).toHaveTextContent('Will be: v=DMARC1; p=none');
		expect(card).not.toHaveTextContent('rua=');
		expect(card.querySelector('mark')).toBeNull();
		expect(screen.getByTestId('reports-note')).toHaveTextContent(sentence);
		// it is information, not an alarm
		expect(screen.getByTestId('reports-note').getAttribute('role')).not.toBe('alert');
		await userEvent.setup().click(screen.getByRole('button', { name: 'Apply 1 change' }));
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});
});

describe("C2 for an agency (\"My clients'\"): the rest of the account is listed, not added", () => {
	it('lists the other zones as "Also in this Cloudflare account", says nothing was added for them and why', async () => {
		open({
			routes: {
				'GET /api/me': { ...me('owner'), whose_email: 'clients' },
				'GET /api/cloudflare/connections/c1/zones': { zones: [{ id: 'z1', name: 'brightwave-mail.com', allowed: true }, { id: 'z2', name: 'harbor-lane.org', allowed: false }, { id: 'z3', name: 'quietfield.net', allowed: false }] },
			},
		});
		expect(await screen.findByRole('heading', { name: '1 change to brightwave-mail.com' })).toBeInTheDocument();
		const note = await screen.findByTestId('also-in-account');
		expect(note).toHaveTextContent('Also in Brightwave Studio: harbor-lane.org, quietfield.net. Not added: this workspace is for brightwave-mail.com. Add each client from Add domain, in its own workspace.');
		expect(note).not.toHaveTextContent('brightwave-mail.com,');
		expect(screen.queryByText(/added and watched/)).toBeNull();
	});

	it('the company case keeps its quiet line: the other zones were added and watched', async () => {
		open({ domains: [domainRow(7, 'brightwave-mail.com'), domainRow(8, 'two.example')] });
		expect(await screen.findByText(/Also in Brightwave Studio: 1 more domain, added and watched/)).toBeInTheDocument();
		expect(screen.queryByTestId('also-in-account')).toBeNull();
	});
});
