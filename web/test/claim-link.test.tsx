import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClaimPage } from '../src/pages/auth/ClaimPage';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { ClaimLinkProvider } from '../src/lib/claim-link';
import { Route, Routes, useLocation } from 'react-router';
import { fail, me, renderApp } from './render';

beforeEach(() => localStorage.clear());

const TOKEN = 'LINKtoken0123456789abcdefghijklmnopqrstuv';
const unconfigured = { configured: false, has_domain: false };

function Where() {
	return <span data-testid="where">{useLocation().pathname}</span>;
}
function Harness() {
	return (
		<ClaimLinkProvider>
			<Where />
			<Routes>
				<Route path="/claim/:token" element={<ClaimPage />} />
				<Route path="*" element={<AuthPage />} />
			</Routes>
		</ClaimLinkProvider>
	);
}

describe('setup link', () => {
	it('replaces the URL, keeps the token in memory only, and shows the form without the installer proof', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: `/claim/${TOKEN}` });
		expect(await screen.findByRole('heading', { name: 'Create the owner account' })).toBeInTheDocument();
		expect(screen.getByTestId('where')).toHaveTextContent('/');
		expect(screen.getByTestId('where')).not.toHaveTextContent(TOKEN);
		expect(screen.getByText('This link works once.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Installer proof')).not.toBeInTheDocument();
		expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(TOKEN);
	});

	it('sends the token as the bootstrap proof', async () => {
		let done = false;
		const { calls } = renderApp(<Harness />, {
			role: null,
			status: unconfigured,
			route: `/claim/${TOKEN}`,
			routes: { 'POST /api/auth/setup': () => ((done = true), { ok: true, has_domain: false }), 'GET /api/me': () => (done ? me('owner') : fail(401)) },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/setup')).toBe(true));
		expect(calls.find((c) => c.path === '/api/auth/setup')?.headers['x-ready-set-mail-bootstrap']).toBe(TOKEN);
	});

	it('explains a refused link', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: `/claim/${TOKEN}`, routes: { 'POST /api/auth/setup': fail(403, 'installer proof required') } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		expect(await screen.findByText(/This setup link has expired or was already used\. Run `npm run setup-link`/)).toBeInTheDocument();
	});

	it('without a link, leads with the instruction and keeps the proof behind a disclosure', async () => {
		renderApp(<AuthPage />, { role: null, status: unconfigured });
		expect(await screen.findByText(/Open the setup link printed when you deployed/)).toBeInTheDocument();
		expect(screen.getByText('I have an installer proof')).toBeInTheDocument();
	});
});
