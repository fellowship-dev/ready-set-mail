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
	it('offers both paths side by side with one primary button, token paste', async () => {
		render(offer());
		expect(await screen.findByRole('heading', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(screen.getByText('Ready Set Mail writes the DNS records for you. You see every record before anything is written.')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: "I'll add DNS records myself" })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Connect Cloudflare' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/setup/cloudflare'));
		expect(JSON.parse(sessionStorage.getItem('rsm_cf_wizard:ws_default')!).step).toBe('connect');
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
	});

	it('members see the manual path only', async () => {
		const { calls } = render(offer(), { role: 'member' });
		expect(await screen.findByRole('heading', { name: "What's your main domain?" })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/cloudflare/connections')).toBe(false);
	});
});
