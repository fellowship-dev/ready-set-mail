import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { Gate } from '../src/app';
import { ClaimLinkProvider } from '../src/lib/claim-link';
import { fail, me, renderApp } from './render';

const PROOF = 'PROOFvalue0123456789abcdefghijklmnopqrstuvwx';
const unconfigured = { configured: false, has_domain: false };

function Where() {
	const l = useLocation();
	return <span data-testid="where">{l.pathname + l.search}</span>;
}
const Harness = () => (
	<ClaimLinkProvider>
		<Where />
		<Routes>
			<Route path="/setup" element={<Gate><span>wizard</span></Gate>} />
		</Routes>
	</ClaimLinkProvider>
);

describe('#/setup?proof=<proof>', () => {
	it('strips the proof from the URL, holds it in memory, shows the form without the proof field and sends it as the bootstrap header', async () => {
		let done = false;
		const { calls } = renderApp(<Harness />, {
			role: null,
			status: unconfigured,
			route: `/setup?proof=${PROOF}`,
			routes: { 'POST /api/auth/setup': () => ((done = true), { ok: true, has_domain: false }), 'GET /api/me': () => (done ? me('owner') : fail(401)) },
		});
		expect(await screen.findByRole('heading', { name: 'Create the owner account' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/));
		expect(screen.queryByLabelText('Installer proof')).not.toBeInTheDocument();
		expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(PROOF);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/setup')).toBe(true));
		expect(calls.find((c) => c.path === '/api/auth/setup')?.headers['x-ready-set-mail-bootstrap']).toBe(PROOF);
	});

	it('is ignored and stripped when the instance is already configured', async () => {
		renderApp(<Harness />, { role: null, status: { configured: true }, route: `/setup?proof=${PROOF}` });
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/));
		expect(screen.queryByRole('heading', { name: 'Create the owner account' })).not.toBeInTheDocument();
	});

	it('is ignored and stripped when signed in', async () => {
		renderApp(<Harness />, { role: 'owner', route: `/setup?proof=${PROOF}` });
		expect(await screen.findByText('wizard')).toBeInTheDocument();
		expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/);
	});
});
