import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { Gate } from '../src/app';
import { ClaimLinkProvider } from '../src/lib/claim-link';
import { fail, me, renderApp } from './render';

const SIG = 'A'.repeat(43);
const token = (expiryOffset = 900) => `${Math.floor(Date.now() / 1000) + expiryOffset}.${SIG}`;
const unconfigured = { configured: false, has_domain: false };
const EXPIRED = 'This setup link has expired. Run `npm run setup -- --new-link` to get a new one.';

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

describe('#/setup?t=<expiry>.<sig>', () => {
	it('is taken out of the URL, held in memory, shows only the owner form and is sent in the header, never in a URL', async () => {
		const t = token();
		let done = false;
		const { calls } = renderApp(<Harness />, {
			role: null,
			status: unconfigured,
			route: `/setup?t=${t}`,
			routes: { 'POST /api/auth/setup': () => ((done = true), { ok: true, has_domain: false }), 'GET /api/me': () => (done ? me('owner') : fail(401)) },
		});
		expect(await screen.findByRole('heading', { name: 'Create the owner account' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/));
		expect(screen.queryByLabelText('Installer proof')).not.toBeInTheDocument();
		expect(screen.queryByText(/works once|keep it private|whoever/i)).not.toBeInTheDocument();
		expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(t);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/setup')).toBe(true));
		expect(calls.find((c) => c.path === '/api/auth/setup')?.headers['x-ready-set-mail-bootstrap']).toBe(t);
		expect(calls.every((c) => !c.path.includes(t))).toBe(true);
	});

	it('an expired token shows the plain expired page and no form', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: `/setup?t=${token(-120)}` });
		expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
		expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
	});

	it('a minute of client clock difference is tolerated', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: `/setup?t=${token(-30)}` });
		expect(await screen.findByRole('heading', { name: 'Create the owner account' })).toBeInTheDocument();
	});

	it('a malformed token shows the expired page', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: '/setup?t=not-a-token' });
		expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
	});

	it('a refused token at submit shows the expired page', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: `/setup?t=${token()}`, routes: { 'POST /api/auth/setup': fail(403, 'installer proof required') } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
	});

	it('without a link the paste form stays, behind its disclosure', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: '/setup' });
		expect(await screen.findByText('I have an installer proof')).toBeInTheDocument();
	});

	it('is ignored and stripped when the instance is already configured, or when signed in', async () => {
		renderApp(<Harness />, { role: null, status: { configured: true }, route: `/setup?t=${token()}` });
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/));
		expect(screen.queryByRole('heading', { name: 'Create the owner account' })).not.toBeInTheDocument();
	});
	it('is stripped when signed in', async () => {
		renderApp(<Harness />, { role: 'owner', route: `/setup?t=${token()}` });
		expect(await screen.findByText('wizard')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/setup$/));
	});
});
