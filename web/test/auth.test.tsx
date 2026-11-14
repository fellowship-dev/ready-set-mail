import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { ForgotPage } from '../src/pages/auth/ForgotPage';
import { InvitePage } from '../src/pages/auth/InvitePage';
import { ResetPage } from '../src/pages/auth/ResetPage';
import { fail, me, renderApp } from './render';

beforeEach(() => localStorage.clear());

/** The session probe ran again after sign-in (the cookie, not a stored token, carries the session). */
const meFetches = (calls: Array<{ path: string }>) => calls.filter((c) => c.path === '/api/me').length;

describe('sign in', () => {
	it('signs in with email and password, refetches the session (cookie only, no token stored)', async () => {
		let signedIn = false;
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			routes: {
				'POST /api/auth/login': () => {
					signedIn = true;
					return { ok: true };
				},
				'GET /api/me': () => (signedIn ? me('owner') : fail(401)),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'correct-horse');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));

		await waitFor(() => expect(meFetches(calls)).toBeGreaterThan(1));
		expect(localStorage.getItem('ia_api_key')).toBeNull();
		expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({ email: 'a@example.com', password: 'correct-horse' });
	});

	it('shows the server message for a wrong password and stays signed out', async () => {
		renderApp(<AuthPage />, { role: null, routes: { 'POST /api/auth/login': fail(401, 'invalid credentials') } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'nope-nope');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));

		expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials');
	});

	it('offers OAuth buttons only for configured providers', async () => {
		renderApp(<AuthPage />, { role: null, status: { oauth_providers: ['github'] } });
		expect(await screen.findByRole('button', { name: 'GitHub' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Google' })).not.toBeInTheDocument();
	});

	it('has no OAuth section and says sign-up is closed on a closed self-hosted instance', async () => {
		renderApp(<AuthPage />, { role: null });
		await screen.findByRole('button', { name: 'Sign in' });
		expect(screen.queryByText('or continue with')).not.toBeInTheDocument();
		expect(screen.getByText(/Sign-up is closed/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Create an account' })).not.toBeInTheDocument();
	});
});

describe('first-run setup', () => {
	it('shows the create-account form when no owner exists, and validates before calling the API', async () => {
		const { calls } = renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false } });
		const user = userEvent.setup();
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Installer proof'), 'installer-proof-012345678901234567890123');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'different-123');
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/auth/setup')).toBe(false);
	});

	it('creates the owner with the telemetry choice', async () => {
		let done = false;
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			status: { configured: false, has_domain: false },
			routes: {
				'POST /api/auth/setup': () => ((done = true), { ok: true, has_domain: false }),
				'GET /api/me': () => (done ? me('owner') : fail(401)),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Installer proof'), 'installer-proof-012345678901234567890123');
		await user.click(screen.getByRole('checkbox'));
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		await waitFor(() => expect(meFetches(calls)).toBeGreaterThan(1));
		expect(localStorage.getItem('ia_api_key')).toBeNull();
		expect(calls.find((c) => c.path === '/api/auth/setup')?.body).toEqual({ name: '', email: 'owner@example.com', password: 'long-enough-1', telemetry: true });
		expect(calls.find((c) => c.path === '/api/auth/setup')?.headers['x-ready-set-mail-bootstrap']).toBe('installer-proof-012345678901234567890123');
		expect(screen.getByLabelText('Installer proof')).toHaveValue('');
	});
});

describe('installer proof', () => {
	it('says where the proof comes from, and explains a rejected one without saying whether one is set', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false }, routes: { 'POST /api/auth/setup': fail(403, 'installer proof required') } });
		const user = userEvent.setup();
		expect(await screen.findByText(/The BOOTSTRAP_SECRET value set on the Worker before its first start/)).toBeInTheDocument();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Installer proof'), 'wrong-proof-0123456789012345678901234');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		expect(await screen.findByText(/That installer proof was not accepted\. Paste the exact BOOTSTRAP_SECRET value/)).toBeInTheDocument();
	});
});

describe('hosted sign-up', () => {
	it('lets people create a workspace when sign-up is open, and switch back', async () => {
		renderApp(<AuthPage />, { role: null, status: { mode: 'saas', signup_open: true } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Create an account' }));
		expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
	});
});

describe('the 6-digit code step', () => {
	const HOSTED = { mode: 'saas' as const, configured: true, signup_open: true, turnstile_site_key: null, legal: { terms_url: 'https://readysetmail.com/terms', privacy_url: 'https://readysetmail.com/privacy', operator_name: 'Fellowship.dev, Inc.' } };

	it('sign-in: password, then the code screen; the sixth digit signs in; "Send a new code" repeats the sign-in', async () => {
		let done = false;
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			status: HOSTED as any,
			routes: {
				'POST /api/auth/login': { code_required: true, purpose: 'signin', email: 'a@example.com', expires_in: 600 },
				'POST /api/auth/code': () => ((done = true), { purpose: 'signin' }),
				'GET /api/me': () => (done ? me('owner') : fail(401)),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'correct-horse');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to a@example.com' })).toBeInTheDocument();
		expect(screen.getByText(/Your password was right\. Enter the code from the email to finish signing in\./)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Send a new code' }));
		await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/login')).toHaveLength(2));
		expect(calls.filter((c) => c.path === '/api/auth/login')[1]!.body).toEqual({ email: 'a@example.com', password: 'correct-horse' });
		await user.type(screen.getByLabelText('6-digit code'), '654321');
		await waitFor(() => expect(meFetches(calls)).toBeGreaterThan(1));
		expect(calls.find((c) => c.path === '/api/auth/code')?.body).toEqual({ code: '654321' });
	});

	it('sign-up (hosted): email, one password with Show, the agreement above the button, then the code', async () => {
		const { calls } = renderApp(<AuthPage initialMode="signup" />, {
			role: null,
			status: HOSTED as any,
			routes: { 'POST /api/auth/signup': { code_required: true, purpose: 'signup', email: 'new@example.com', expires_in: 600 } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'new@example.com');
		const password = screen.getByLabelText('Password');
		await user.type(password, 'long-enough-1');
		expect(screen.queryByLabelText('Confirm password')).toBeNull();
		expect(password).toHaveAttribute('type', 'password');
		await user.click(screen.getByRole('button', { name: 'Show password' }));
		expect(password).toHaveAttribute('type', 'text');
		expect(screen.queryByText(/DMARC reports are not connected yet/)).toBeNull();
		const agreement = screen.getByText(/By creating an account you agree to the/);
		expect(agreement).toHaveTextContent('By creating an account you agree to the Terms and the Privacy Policy.');
		const button = screen.getByRole('button', { name: 'Create account' });
		expect(agreement.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await user.click(button);
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to new@example.com' })).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/signup')?.body).toEqual({ email: 'new@example.com', password: 'long-enough-1' });
		await user.click(screen.getByRole('button', { name: 'Use a different email' }));
		expect(await screen.findByLabelText('Email')).toHaveValue('new@example.com');
	});

	it('the terms links open in a new tab; the hosted footer has Terms, Privacy and nothing on self-host', async () => {
		const { unmount } = renderApp(<AuthPage initialMode="signup" />, { role: null, status: HOSTED as any });
		const links = await screen.findAllByRole('link', { name: 'Terms' });
		for (const l of links) {
			expect(l).toHaveAttribute('href', 'https://readysetmail.com/terms');
			expect(l).toHaveAttribute('target', '_blank');
		}
		expect(screen.getByRole('navigation', { name: 'Legal and help' })).toBeInTheDocument();
		unmount();
		renderApp(<AuthPage />, { role: null, status: { mode: 'self-host', configured: true, legal: { terms_url: null, privacy_url: null, operator_name: null } } as any });
		await screen.findByLabelText('Email');
		expect(screen.queryByRole('navigation', { name: 'Legal and help' })).toBeNull();
		expect(screen.queryByRole('link', { name: 'Terms' })).toBeNull();
	});
});

describe('forgot and reset', () => {
	it('asks for the email, then one screen with the code and the new password; saving it signs in', async () => {
		let reset = false;
		const { calls } = renderApp(
			<Routes>
				<Route path="/forgot" element={<ForgotPage />} />
				<Route path="/" element={<p>home</p>} />
			</Routes>,
			{
				role: null,
				route: '/forgot',
				routes: {
					'POST /api/auth/forgot': { code_required: true, purpose: 'reset', email: 'whoever@example.com', expires_in: 600 },
					'POST /api/auth/reset': () => ((reset = true), { purpose: 'reset' }),
					'GET /api/me': () => (reset ? me('owner') : fail(401)),
				},
			},
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'whoever@example.com');
		await user.click(screen.getByRole('button', { name: 'Send code' }));
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to whoever@example.com' })).toBeInTheDocument();
		expect(screen.getByText(/Enter the code from the email and choose a new password\. Then you are signed in\./)).toBeInTheDocument();
		await user.type(screen.getByLabelText('6-digit code'), '123456');
		expect(calls.some((c) => c.path === '/api/auth/reset')).toBe(false); // the sixth digit moves on to the password
		await user.type(screen.getByLabelText('New password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
		expect(await screen.findByText('home')).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/reset')?.body).toEqual({ code: '123456', password: 'long-enough-1' });
	});

	it('an old reset link says to ask for a code, and calls nothing', async () => {
		const { calls } = renderApp(
			<Routes>
				<Route path="/reset/:token" element={<ResetPage />} />
			</Routes>,
			{ role: null, route: '/reset/abcdefghijkl' },
		);
		expect(await screen.findByRole('heading', { name: 'This reset link no longer works' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Reset your password' })).toHaveAttribute('href', '/forgot');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});

describe('invite', () => {
	const route = (
		<Routes>
			<Route path="/invite/:token" element={<InvitePage />} />
		</Routes>
	);

	it('shows who invited you and the role, then accepts', async () => {
		let accepted = false;
		const { calls } = renderApp(route, {
			role: null,
			route: '/invite/tok123',
			routes: {
				'GET /api/invites/tok123': { email: 'new@example.com', invited_by: 'boss@example.com', role: 'member' },
				'POST /api/invites/tok123': () => ((accepted = true), { ok: true }),
				'GET /api/me': () => (accepted ? me('member') : fail(401)),
			},
		});
		const user = userEvent.setup();
		expect(await screen.findByText('boss@example.com')).toBeInTheDocument();
		expect(screen.getByLabelText('Invited email')).toHaveTextContent('new@example.com');
		await user.type(screen.getByLabelText('Your name'), 'New Person');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		await waitFor(() => expect(meFetches(calls)).toBeGreaterThan(1));
		expect(localStorage.getItem('ia_api_key')).toBeNull();
		expect(calls.find((c) => c.method === 'POST' && c.path === '/api/invites/tok123')?.body).toEqual({ name: 'New Person', password: 'long-enough-1' });
	});

	it('distinguishes a dead invite (404) from a failed lookup', async () => {
		renderApp(route, { role: null, route: '/invite/gone', routes: { 'GET /api/invites/gone': fail(404, 'invite not found or expired') } });
		expect(await screen.findByRole('heading', { name: 'Invite not found' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
	});

	it('offers a retry when the server fails', async () => {
		renderApp(route, { role: null, route: '/invite/x', routes: { 'GET /api/invites/x': fail(503) } });
		expect(await screen.findByRole('heading', { name: 'Could not load the invite' }, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	describe('for an email that already has a login', () => {
		const info = (extra = {}) => ({ email: 'sam@example.com', invited_by: 'max@example.com', role: 'member', workspace_id: 'ws_lexgo', workspace_name: 'Lexgo', user_exists: true, signed_in_as: null, ...extra });

		it('names the workspace and asks for a password only to sign in, never a new account', async () => {
			let loggedIn = false;
			const { calls } = renderApp(route, {
				role: null,
				route: '/invite/tok9',
				routes: { 'GET /api/invites/tok9': () => info(loggedIn ? { signed_in_as: 'sam@example.com' } : {}), 'POST /api/auth/login': () => ((loggedIn = true), { ok: true }), 'GET /api/me': () => (loggedIn ? me('member') : fail(401)), 'GET /api/workspaces': { workspaces: [] } },
			});
			expect(await screen.findByText('Lexgo')).toBeInTheDocument();
			expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
			expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
			const user = userEvent.setup();
			await user.type(screen.getByLabelText('Password'), 'sams-password');
			await user.click(screen.getByRole('button', { name: 'Sign in to accept' }));
			await waitFor(() => expect(meFetches(calls)).toBeGreaterThan(1));
		expect(localStorage.getItem('ia_api_key')).toBeNull();
			expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({ email: 'sam@example.com', password: 'sams-password' });
			// now signed in as the invited address, the page offers the one-click accept
			expect(await screen.findByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
		});

		it('signed in as that email: one click accepts and opens the workspace', async () => {
			let accepted = false;
			const { calls } = renderApp(route, {
				role: 'member',
				route: '/invite/tok9',
				routes: {
					'GET /api/invites/tok9': info({ signed_in_as: 'sam@example.com' }),
					'POST /api/invites/tok9': () => ((accepted = true), { ok: true, workspace_id: 'ws_lexgo', workspace_name: 'Lexgo' }),
					'GET /api/workspaces': { workspaces: [] },
				},
			});
			const user = userEvent.setup();
			await user.click(await screen.findByRole('button', { name: 'Accept invite' }));
			await waitFor(() => expect(accepted).toBe(true));
			expect(calls.find((c) => c.method === 'POST' && c.path === '/api/invites/tok9')?.body).toEqual({});
			await waitFor(() => expect(window.location.hash).toBe('#/w/ws_lexgo/'));
		});

		it('signed in as someone else: says so, names both addresses, offers sign out, and does not accept', async () => {
			const { calls } = renderApp(route, { role: 'owner', route: '/invite/tok9', routes: { 'GET /api/invites/tok9': info({ signed_in_as: 'owner@example.com' }) } });
			expect(await screen.findByText(/This invite is for sam@example.com, but you are signed in as owner@example.com/)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument();
			expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/invites/'))).toBe(false);
		});
	});
});
