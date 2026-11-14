import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, renderApp } from './render';

function Where() {
	return <p data-testid="where">{useLocation().pathname}</p>;
}
const Page = () => (
	<>
		<Routes>
			<Route path="/setup" element={<SetupWizardPage />} />
			<Route path="/setup/cloudflare" element={<p>Cloudflare wizard</p>} />
		</Routes>
		<Where />
	</>
);

const offer = (over: Record<string, unknown> = {}) => ({
	connections: [],
	oauth: { available: false, scopes: [], via_relay: false },
	token_paste: true,
	encryption_configured: true,
	...over,
});
const base = { 'GET /api/domains': { domains: [] }, 'GET /api/zones': { zones: [] } };
const render = (conns: unknown, opts: { role?: 'owner' | 'member'; hosted?: boolean } = {}) =>
	renderApp(<Page />, {
		route: '/setup',
		role: opts.role,
		status: opts.hosted ? { mode: 'saas', has_domain: false } : { has_domain: false },
		routes: { ...base, 'GET /api/cloudflare/connections': conns },
	});

beforeEach(() => sessionStorage.clear());

describe('first screen: Cloudflare first', () => {
	it('leads with Connect Cloudflare and what it does; manual is a quiet link, no progress bar yet', async () => {
		render(offer());
		expect(await screen.findByRole('heading', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		for (const t of ['Reads the zones in your Cloudflare account', 'Shows every record before anything is written', 'Writes them when you press the button']) expect(screen.getByText(t)).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeInTheDocument();
		expect(screen.queryByRole('progressbar')).toBeNull();
		expect(screen.queryByText('Routing')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('heading', { name: "I'll add DNS records myself" })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Connect Cloudflare' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/setup/cloudflare'));
		expect(JSON.parse(sessionStorage.getItem('rsm_cf_wizard:ws_default')!).step).toBe('connect');
	});

	it('"I\'ll add DNS records myself" reveals the domain form, focuses it and shows the five-step bar', async () => {
		render(offer());
		await userEvent.click(await screen.findByRole('button', { name: "I'll add DNS records myself" }));
		expect(screen.getByRole('heading', { name: "I'll add DNS records myself" })).toBeInTheDocument();
		expect(screen.getByRole('textbox')).toHaveFocus();
		expect(screen.getByText('Routing')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});

	it('offers OAuth the same way', async () => {
		render(offer({ oauth: { available: true, scopes: [], via_relay: false }, token_paste: true }));
		expect(await screen.findByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});

	it('says Cloudflare is connected and goes to the domains step', async () => {
		render(offer({ connections: [{ id: 'c1', label: 'Acme', auth_type: 'token', status: 'active', cf_account_name: 'Acme', zones: [{ id: 'z', name: 'a.com' }], scopes: [] }] }));
		expect(await screen.findByRole('heading', { name: 'Cloudflare is connected' })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Choose domains' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/setup/cloudflare'));
		expect(JSON.parse(sessionStorage.getItem('rsm_cf_wizard:ws_default')!)).toMatchObject({ step: 'domains', connectionId: 'c1' });
	});

	it('treats the server token as connected', async () => {
		render(offer({ connections: [{ id: 'env', label: 'Server', auth_type: 'token', status: 'active', zones: [], scopes: [], implicit: true }], encryption_configured: false, token_paste: false }));
		expect(await screen.findByRole('heading', { name: 'Cloudflare is connected' })).toBeInTheDocument();
	});

	it('explains a missing encryption key, with the command, and keeps the manual card', async () => {
		render(offer({ encryption_configured: false, token_paste: false }));
		expect(await screen.findByRole('heading', { name: "Cloudflare can't be connected yet" })).toBeInTheDocument();
		expect(screen.getByText(/This instance has no key to store a Cloudflare connection/)).toBeInTheDocument();
		expect(screen.getByText(/npx wrangler secret put TOKEN_ENCRYPTION_KEY/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Or add your records yourself →' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
	});

	it('hosted without Cloudflare support shows today\'s form only', async () => {
		render(offer({ encryption_configured: false, token_paste: false }), { hosted: true });
		expect(await screen.findByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
	});

	it('a failing connections request shows today\'s form only', async () => {
		render(fail(500, 'boom'));
		expect(await screen.findByRole('heading', { name: "What's your main domain?" })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
		expect(screen.getByText('Routing')).toBeInTheDocument(); // today's screen, progress bar included
	});

	it('members see the manual path only', async () => {
		const { calls } = render(offer(), { role: 'member' });
		expect(await screen.findByRole('heading', { name: "What's your main domain?" })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/cloudflare/connections')).toBe(false);
	});

	it('hosted with a pasted-token path shows the two-path chooser', async () => {
		render(offer(), { hosted: true });
		expect(await screen.findByRole('heading', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: "I'll add DNS records myself" })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(screen.queryByText('Routing')).toBeNull();
		expect(screen.queryByText(/TOKEN_ENCRYPTION_KEY/)).not.toBeInTheDocument();
	});

	it('hosted with OAuth shows the chooser', async () => {
		render(offer({ oauth: { available: true, scopes: [], via_relay: false } }), { hosted: true });
		expect(await screen.findByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});

	it('hosted without an encryption key never shows the self-host command, whatever else is reported', async () => {
		render(offer({ encryption_configured: false, token_paste: true }), { hosted: true });
		expect(await screen.findByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
		expect(screen.queryByText(/TOKEN_ENCRYPTION_KEY|wrangler/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
	});

	it('hosted: a waiting claim offers to connect Cloudflare to verify it', async () => {
		renderApp(<Page />, {
			route: '/setup',
			status: { mode: 'saas', has_domain: false },
			routes: {
				...base,
				'GET /api/cloudflare/connections': offer(),
				'GET /api/domains/dns-host?name=acme.org': { provider: { id: 'cloudflare', name: 'Cloudflare' }, nameservers: ['a.ns.cloudflare.com'], status: 'known' },
				'GET /api/domains': { domains: [], pending_claims: [{ id: 5, domain: 'acme.org', status: 'pending', txt_name: '_readysetmail.acme.org', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null }] },
			},
		});
		expect(await screen.findByText('acme.org uses Cloudflare for DNS. Connect Cloudflare and we add the record and verify for you')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});
});
