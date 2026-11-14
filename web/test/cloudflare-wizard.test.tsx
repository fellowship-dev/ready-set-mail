import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CloudflareWizardPage } from '../src/pages/wizards/cloudflare/CloudflareWizardPage';
import { Route, Routes } from 'react-router';
import { fail, renderApp } from './render';

const KEY = 'rsm_cf_wizard:ws_default';
const conn = (over: Record<string, unknown> = {}) => ({ id: 'c1', label: 'Acme', auth_type: 'token', status: 'active', cf_account_name: 'Acme', zones: [], scopes: [], ...over });
const offer = (over: Record<string, unknown> = {}) => ({ connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true, ...over });
const zone = (n: number, allowed = false) => ({ id: `z${n}`.padEnd(32, '0'), name: `d${n}.example.com`, allowed });
const plan = { plan_id: 'p', steps: [{ key: 'dmarc', writes: [], satisfied: true }], not_written: [] };

const Page = () => (
	<Routes>
		<Route path="/setup/cloudflare" element={<CloudflareWizardPage />} />
	</Routes>
);
const render = (routes: Record<string, unknown>, role: 'owner' | 'member' = 'owner') => renderApp(<Page />, { route: '/setup/cloudflare', role, routes });

beforeEach(() => {
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});

describe('Cloudflare wizard: connect', () => {
	it('connects with a pasted token and moves to zones', async () => {
		let zonesCalled = false;
		const { calls } = render({
			'GET /api/cloudflare/connections': offer(),
			'POST /api/cloudflare/connections': { connection: conn() },
			'GET /api/cloudflare/connections/c1/zones': () => ((zonesCalled = true), { zones: [zone(1)] }),
		});
		expect(await screen.findByText('Zone Resources: the zones you want Ready Set Mail to manage.')).toBeInTheDocument();
		expect(screen.getByText(/It writes only the DMARC, report-authorisation and reports-mailbox records you approve/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Create a token at Cloudflare' })).toHaveAttribute('href', 'https://dash.cloudflare.com/profile/api-tokens');
		const field = screen.getByLabelText('Cloudflare API token');
		expect(field).toHaveAttribute('type', 'password');
		await userEvent.type(field, 'x'.repeat(40));
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
		expect(await screen.findByRole('heading', { name: 'Choose zones' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { level: 1, name: 'Set up with Cloudflare' })).toBeInTheDocument();
		expect(zonesCalled).toBe(true);
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ token: 'x'.repeat(40) });
	});

	it('shows verify errors inline and the encryption message on 503', async () => {
		let status = 502;
		render({
			'GET /api/cloudflare/connections': offer(),
			'POST /api/cloudflare/connections': () => (status === 502 ? fail(502, 'Cloudflare refused the request: check the token and its permissions') : { __status: 503, body: { error: 'x', code: 'encryption_not_configured' } }),
		});
		await userEvent.type(await screen.findByLabelText('Cloudflare API token'), 'y'.repeat(30));
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
		expect(await screen.findByText(/check the token and its permissions/)).toBeInTheDocument();
		status = 503;
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
		expect(await screen.findByText(/This instance has no key to store a Cloudflare connection/)).toBeInTheDocument();
	});

	it('cleans ?cf_connection= from the address and moves on', async () => {
		window.history.replaceState(null, '', '/?cf_connection=c1&x=1#/setup/cloudflare');
		render({
			'GET /api/cloudflare/connections': offer({ oauth: { available: true, scopes: [], via_relay: false }, connections: [conn()] }),
			'GET /api/cloudflare/connections/c1/zones': { zones: [zone(1)] },
		});
		expect(await screen.findByRole('heading', { name: 'Choose zones' })).toBeInTheDocument();
		expect(window.location.search).toBe('?x=1');
		expect(window.location.hash).toBe('#/setup/cloudflare');
	});

	it('shows ?cf_error= in words and offers Continue to Cloudflare again', async () => {
		window.history.replaceState(null, '', '/?cf_error=access_denied#/setup/cloudflare');
		render({ 'GET /api/cloudflare/connections': offer({ oauth: { available: true, scopes: [], via_relay: false } }) });
		expect(await screen.findByText(/Cloudflare access was not granted/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Continue to Cloudflare' })).toBeInTheDocument();
		expect(window.location.search).toBe('');
	});

	it('starts OAuth with the current route as return_to', async () => {
		window.history.replaceState(null, '', '/#/setup/cloudflare');
		const { calls } = render({
			'GET /api/cloudflare/connections': offer({ oauth: { available: true, scopes: [], via_relay: false } }),
			'POST /api/cloudflare/oauth/start': { authorize_url: 'about:blank#cf' },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Continue to Cloudflare' }));
		await waitFor(() => expect(calls.find((c) => c.path === '/api/cloudflare/oauth/start')?.body).toEqual({ return_to: '/#/setup/cloudflare' }));
	});

	it('tells members they cannot connect', async () => {
		render({ 'GET /api/cloudflare/connections': fail(403) }, 'member');
		expect(await screen.findByText(/Only owners and admins can connect Cloudflare/)).toBeInTheDocument();
	});
});

describe('Cloudflare wizard: zones', () => {
	const at = (zones: ReturnType<typeof zone>[]) => {
		sessionStorage.setItem(KEY, JSON.stringify({ step: 'zones', domainIds: [], written: { domains: 0, records: 0 }, connectionId: 'c1' }));
		return render({
			'GET /api/cloudflare/connections': offer({ connections: [conn()] }),
			'GET /api/cloudflare/connections/c1/zones': { zones },
			'PUT /api/cloudflare/connections/c1/zones': { zones: [] },
			'GET /api/domains': { domains: [] },
			'GET /api/onboarding/dns-state': { states: [] },
		});
	};

	it('pre-ticks every zone when there are 10 or fewer, saves, and moves to domains', async () => {
		const { calls } = at([zone(1), zone(2), zone(3)]);
		const boxes = await screen.findAllByRole('checkbox');
		expect(boxes).toHaveLength(3);
		boxes.forEach((b) => expect(b).toBeChecked());
		await userEvent.click(boxes[1]!);
		await userEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(await screen.findByRole('heading', { name: 'Choose domains' })).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ zone_ids: [zone(1).id, zone(3).id] });
	});

	it('ticks nothing above 10, and Select all ticks everything', async () => {
		at(Array.from({ length: 11 }, (_, i) => zone(i + 1)));
		const boxes = await screen.findAllByRole('checkbox');
		boxes.forEach((b) => expect(b).not.toBeChecked());
		expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
		await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
		screen.getAllByRole('checkbox').forEach((b) => expect(b).toBeChecked());
		expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
	});
});

describe('Cloudflare wizard: domains', () => {
	const setup = (extra: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => {
		sessionStorage.setItem(KEY, JSON.stringify({ step: 'domains', domainIds: [], written: { domains: 0, records: 0 }, connectionId: 'c1' }));
		return renderApp(<Page />, {
			route: '/setup/cloudflare',
			status,
			routes: {
				'GET /api/cloudflare/connections': offer({ connections: [conn({ zones: [{ id: 'a', name: 'a.example.com' }] })] }),
				'GET /api/cloudflare/connections/c1/zones': { zones: [{ id: 'za', name: 'a.example.com', allowed: true }, { id: 'zb', name: 'b.example.com', allowed: true }, { id: 'zc', name: 'c.example.com', allowed: false }] },
				'GET /api/onboarding/dns-state': { states: [
					{ name: 'a.example.com', resolves: true, spf: 'found', dmarc: { state: 'found', policy: 'none' }, mx: true },
					{ name: 'b.example.com', resolves: true, spf: 'missing', dmarc: { state: 'missing' }, mx: null },
				] },
				'GET /api/domains': { domains: [{ id: 1, domain: 'a.example.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 }] },
				'PUT /api/domains/1/connection': { ok: true },
				'POST /api/domains': { domain: { id: 2, domain: 'b.example.com' } },
				'PUT /api/domains/2/connection': { ok: true },
				'POST /api/onboarding/dns-plan': plan,
				...extra,
			},
		});
	};

	it('lists allowed zones with DNS status, marks existing ones, adds and links', async () => {
		const { calls } = setup();
		expect(await screen.findByText('b.example.com')).toBeInTheDocument();
		expect(screen.queryByText('c.example.com')).not.toBeInTheDocument();
		expect(await screen.findByText('SPF missing · DMARC missing')).toBeInTheDocument();
		expect(screen.getByText('SPF found · DMARC p=none')).toBeInTheDocument();
		expect(screen.getByText('Already added')).toBeInTheDocument();
		expect(screen.getByRole('checkbox', { name: /a\.example\.com/ })).toBeDisabled();
		await userEvent.click(screen.getByRole('button', { name: 'Add 1 domain' }));
		// One click: it adds, links and moves on by itself.
		expect(await screen.findByText(/Already in place/)).toBeInTheDocument();
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(['POST /api/domains', 'PUT /api/domains/2/connection']));
		await waitFor(() => expect(JSON.parse(sessionStorage.getItem(KEY)!)).toMatchObject({ step: 'dmarc', domainIds: expect.arrayContaining([1, 2]), written: { domains: 1, records: 0 } }));
		expect(await screen.findByText(/Already in place/)).toBeInTheDocument();
	});

	it('shows a failure inline and retries only that domain', async () => {
		let n = 0;
		const { calls } = setup({ 'POST /api/domains': () => (++n === 1 ? fail(400, 'Cloudflare says no') : { domain: { id: 2, domain: 'b.example.com' } }) });
		await userEvent.click(await screen.findByRole('button', { name: 'Add 1 domain' }));
		expect(await screen.findByText(/b\.example\.com: Cloudflare says no/)).toBeInTheDocument();
		// the only success so far is a.example.com (already added), so "Continue without them" is offered next to the single primary
		expect(await screen.findByRole('button', { name: 'Continue without them' })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
		// every chosen domain now succeeded: it moves on by itself
		expect(await screen.findByText(/Already in place/)).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/domains')).toHaveLength(2);
	});

	it('a failure keeps the person on the step: Continue without them moves on with what worked', async () => {
		setup({ 'POST /api/domains': fail(400, 'Cloudflare says no') });
		await userEvent.click(await screen.findByRole('button', { name: 'Add 1 domain' }));
		await screen.findByText(/b\.example\.com: Cloudflare says no/);
		expect(screen.getByRole('heading', { name: 'Choose domains' })).toBeInTheDocument();
		await screen.findByRole('button', { name: 'Continue without them' });
		expect(screen.getAllByRole('button').filter((b) => b.className.includes('bg-brand'))).toHaveLength(1);
		await userEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
		await waitFor(() => expect(JSON.parse(sessionStorage.getItem(KEY)!)).toMatchObject({ step: 'dmarc', domainIds: [1] }));
	});

	it('hosted: a full plan keeps what was added', async () => {
		setup({ 'POST /api/domains': { __status: 403, body: { error: 'Your plan allows 1 domain.', code: 'plan_limit', limit: { kind: 'domains_per_workspace' } } } }, { mode: 'saas' });
		await userEvent.click(await screen.findByRole('button', { name: 'Add 1 domain' }));
		expect(await screen.findByText('Your plan allows 1 domain.')).toBeInTheDocument();
		expect(screen.getByText('Not added: your plan is full.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
	});

	it('self-host without a base domain asks where reports go and uses base-domain first', async () => {
		const { calls } = setup(
			{ 'GET /api/domains': { domains: [] }, 'POST /api/settings/base-domain': { ok: true, domain: 'a.example.com', domain_id: 1 } },
			{ base_domain: null, has_domain: false },
		);
		expect(await screen.findByText('Reports go to')).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Add 2 domains' }));
		await screen.findByText(/Already in place/);
		const posts = calls.filter((c) => c.method === 'POST' && /base-domain|\/api\/domains$/.test(c.path)).map((c) => c.path);
		expect(posts).toEqual(['/api/settings/base-domain', '/api/domains']);
	});
});

describe('Cloudflare wizard: resume', () => {
	it('resumes at the saved step after a reload', async () => {
		sessionStorage.setItem(KEY, JSON.stringify({ step: 'dmarc', domainIds: [1, 2], written: { domains: 2, records: 0 }, connectionId: 'c1' }));
		const { calls } = render({
			'GET /api/cloudflare/connections': offer({ connections: [conn()] }),
			'POST /api/onboarding/dns-plan': plan,
		});
		expect(await screen.findByText(/Already in place/)).toBeInTheDocument();
		expect(screen.getByText(/Step 4 of 6/)).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/onboarding/dns-plan')?.body).toEqual({ domain_ids: [1, 2] });
	});

	it('persists progress as it moves', async () => {
		render({ 'GET /api/cloudflare/connections': offer({ connections: [conn()] }), 'GET /api/cloudflare/connections/c1/zones': { zones: [] } });
		await screen.findByRole('heading', { name: 'Choose zones' });
		expect(JSON.parse(sessionStorage.getItem(KEY)!)).toMatchObject({ step: 'zones', connectionId: 'c1' });
	});

	it('hosted has no Reports mailbox step', async () => {
		renderApp(<Page />, { route: '/setup/cloudflare', status: { mode: 'saas' }, routes: { 'GET /api/cloudflare/connections': offer() } });
		expect(await screen.findByText(/Step 1 of 5/)).toBeInTheDocument();
	});
});
