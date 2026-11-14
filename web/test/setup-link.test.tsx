import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HashRouter, Route, Routes, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { Gate } from '../src/app';
import { ClaimLinkProvider } from '../src/lib/claim-link';
import { createQueryClient } from '../src/lib/query';
import { SessionProvider, useSession } from '../src/lib/session';
import { fail, me, mockApi, renderApp, STATUS } from './render';

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

function Ready({ children }: { children: ReactNode }) {
	const { state } = useSession();
	return state === 'authed' || state === 'anon' ? <>{children}</> : null;
}

describe('the address bar and history (real HashRouter)', () => {
	it('the token is removed with history.replaceState as soon as it is read: no new entry, no t= in the URL, and it only travels in the header', async () => {
		const t = token();
		window.history.replaceState(null, '', `/#/setup?t=${t}`);
		const lengthBefore = window.history.length;
		const push = vi.spyOn(window.history, 'pushState');
		const replace = vi.spyOn(window.history, 'replaceState');
		const api = mockApi({ 'GET /api/auth/status': { ...STATUS, configured: false, has_domain: false }, 'GET /api/me': fail(401), 'POST /api/auth/setup': { ok: true, has_domain: false } });
		render(
			<QueryClientProvider client={createQueryClient()}>
				<SessionProvider>
					<Ready>
						<HashRouter>
							<ClaimLinkProvider>
								<Routes>
									<Route path="/setup" element={<Gate><span>wizard</span></Gate>} />
								</Routes>
							</ClaimLinkProvider>
						</HashRouter>
					</Ready>
				</SessionProvider>
			</QueryClientProvider>,
		);
		expect(await screen.findByRole('heading', { name: 'Create the owner account' })).toBeInTheDocument();
		await waitFor(() => expect(window.location.hash).toBe('#/setup'));
		expect(window.location.href).not.toContain('t=');
		expect(window.location.href).not.toContain(t);
		expect(window.history.length).toBe(lengthBefore);
		expect(push).not.toHaveBeenCalled();
		expect(replace.mock.calls.some((c) => String(c[2]).includes('t=') === false)).toBe(true);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await waitFor(() => expect(api.calls.some((c) => c.path === '/api/auth/setup')).toBe(true));
		expect(api.calls.every((c) => !c.path.includes(t))).toBe(true);
		expect(api.calls.find((c) => c.path === '/api/auth/setup')?.headers['x-ready-set-mail-bootstrap']).toBe(t);
		push.mockRestore();
		replace.mockRestore();
		window.history.replaceState(null, '', '/');
	});

	it('the paste form names the installer path and a signed link shows no proof field', async () => {
		renderApp(<Harness />, { role: null, status: unconfigured, route: '/setup' });
		await screen.findByText('I have an installer proof');
		await userEvent.setup().click(screen.getByText('I have an installer proof'));
		expect(await screen.findByText(/~\/\.config\/ready-set-mail\/<name>\/bootstrap-proof/)).toBeInTheDocument();
	});
});
