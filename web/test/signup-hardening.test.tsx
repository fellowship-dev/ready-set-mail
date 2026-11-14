// The human check is rendered explicitly, per form, and stays out of the way; old emailed links; names render clean.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanName } from '../src/lib/names';
import type { AuthStatus } from '../src/lib/types';
import { CodeStep } from '../src/pages/auth/CodeStep';
import { ForgotPage } from '../src/pages/auth/ForgotPage';
import { __resetTurnstileLoaderForTests } from '../src/pages/auth/Turnstile';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { MembersPage } from '../src/pages/members/MembersPage';
import { fail, me, renderApp } from './render';

const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, turnstile_site_key: '1x00000000000000000000AA' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.sig';

beforeEach(() => localStorage.clear());

/** A stand-in for Cloudflare's script, already loaded: records render/reset/remove; `solve()` plays the widget's callback. */
function fakeTurnstile() {
	const widgets: Array<{ el: HTMLElement; opts: any; id: string }> = [];
	const api = {
		render: vi.fn((el: HTMLElement, opts: any) => {
			const id = `w${widgets.length + 1}`;
			widgets.push({ el, opts, id });
			return id;
		}),
		reset: vi.fn(),
		remove: vi.fn(),
	};
	window.turnstile = api as any;
	const solve = (token = 'tok-1', i = widgets.length - 1) => act(() => widgets[i]!.opts.callback(token));
	return { api, widgets, solve };
}
afterEach(() => {
	delete window.turnstile;
	__resetTurnstileLoaderForTests();
	document.querySelectorAll('script[data-cf-turnstile]').forEach((el) => el.remove());
});

describe('the human check is rendered explicitly, per form', () => {
	const forgot = () => renderApp(<ForgotPage />, { role: null, status: HOSTED, routes: { 'POST /api/auth/forgot': { code_required: true, purpose: 'reset', email: 'a@example.com', expires_in: 600 } } });

	it('a form with the check: rendered on this screen (interaction-only, so it shows only when Cloudflare needs it), the button waits for it, sends its token, then resets', async () => {
		const t = fakeTurnstile();
		const { calls } = forgot();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		const button = screen.getByRole('button', { name: 'Send code' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		expect(t.api.render.mock.calls[0]![0]).toBe(screen.getByTestId('human-check'));
		expect(t.api.render.mock.calls[0]![1]).toMatchObject({ sitekey: HOSTED.turnstile_site_key, appearance: 'interaction-only', size: 'flexible' });
		expect(button).toBeDisabled();
		expect(screen.getByText('Waiting for the human check…')).toBeInTheDocument();
		await t.solve('tok-1');
		expect(button).toBeEnabled();
		await user.click(button);
		expect(await screen.findByLabelText('6-digit code')).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/forgot')?.body).toEqual({ email: 'a@example.com', cf_turnstile_token: 'tok-1' });
		expect(t.api.reset).toHaveBeenCalledWith('w1'); // a token is single use
	});

	it('an expired token disables the button again', async () => {
		const t = fakeTurnstile();
		forgot();
		const button = await screen.findByRole('button', { name: 'Send code' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalled());
		await t.solve('tok-1');
		expect(button).toBeEnabled();
		await act(() => t.widgets[0]!.opts['expired-callback']());
		expect(button).toBeDisabled();
		expect(t.api.reset).toHaveBeenCalledWith('w1');
	});

	it('a check that does not pass says so and offers another try', async () => {
		const t = fakeTurnstile();
		forgot();
		const button = await screen.findByRole('button', { name: 'Send code' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		await act(() => t.widgets[0]!.opts['error-callback']());
		expect(button).toBeDisabled();
		expect(screen.getByRole('alert')).toHaveTextContent('The human check did not pass. Try it again or reload the page.');
		await userEvent.setup().click(screen.getByRole('button', { name: 'Try it again' }));
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(2));
		expect(t.api.remove).toHaveBeenCalledWith('w1');
	});

	it('the widget is removed when its form goes away, and a form reached by in-app navigation gets its own', async () => {
		const t = fakeTurnstile();
		const { unmount } = forgot();
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		unmount();
		expect(t.api.remove).toHaveBeenCalledWith('w1');
		forgot();
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(2));
	});

	it('loads the script once, explicitly; if it cannot load, says so and retries', async () => {
		forgot();
		await screen.findByRole('button', { name: 'Send code' });
		const script = await waitFor(() => {
			const s = document.querySelector<HTMLScriptElement>('script[data-cf-turnstile]');
			expect(s).not.toBeNull();
			return s!;
		});
		expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
		await act(async () => script.onerror!(new Event('error')));
		expect(await screen.findByRole('alert')).toHaveTextContent('The human check could not be loaded. Check your connection, then try again.');
		const t = fakeTurnstile(); // the network is back
		await userEvent.setup().click(screen.getByRole('button', { name: 'try again' }));
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
	});

	it('no site key: no widget and nothing to wait for', async () => {
		renderApp(<ForgotPage />, { role: null, status: { ...HOSTED, turnstile_site_key: null } });
		expect(await screen.findByRole('button', { name: 'Send code' })).toBeEnabled();
		expect(screen.queryByTestId('human-check')).toBeNull();
	});
});

describe('the code screen', () => {
	function codeStep(onSubmit = vi.fn(async () => {}), onResend = vi.fn(async () => {})) {
		renderApp(<CodeStep email="a@example.com" purpose="signup" onSubmit={onSubmit} onResend={onResend} onChangeEmail={() => {}} />, { role: null, status: HOSTED });
		return { onSubmit, onResend };
	}

	it('says what it is for above one code input; no human check until "Send a new code" is used', async () => {
		const t = fakeTurnstile();
		codeStep();
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to a@example.com' })).toBeInTheDocument();
		expect(screen.getByText(/This confirms your email address\. Once the code is in, your account is ready and you are signed in\. The code expires in 10 minutes\./)).toBeInTheDocument();
		const input = screen.getByLabelText('6-digit code');
		expect(input).toHaveAttribute('inputmode', 'numeric');
		expect(input).toHaveAttribute('autocomplete', 'one-time-code');
		expect(screen.queryByTestId('human-check')).toBeNull();
		expect(t.api.render).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Use a different email' })).toBeInTheDocument();
	});

	it('pasting "123 456" submits on the sixth digit', async () => {
		const { onSubmit } = codeStep();
		const user = userEvent.setup();
		await user.click(await screen.findByLabelText('6-digit code'));
		await user.paste('123 456');
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('123456'));
	});

	it('"Send a new code" shows the check under the action, then asks for the code as soon as it is solved', async () => {
		const t = fakeTurnstile();
		const { onResend } = codeStep();
		const user = userEvent.setup();
		const send = await screen.findByRole('button', { name: 'Send a new code' });
		await user.click(send);
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		const widget = screen.getByTestId('human-check');
		expect(send.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await t.solve('tok-7');
		await waitFor(() => expect(onResend).toHaveBeenCalledWith('tok-7'));
		expect(await screen.findByText('A new code is on its way to a@example.com. The previous code no longer works.')).toBeInTheDocument();
	});

	it('a wrong code shows the server\'s sentence and clears the input', async () => {
		const { ApiError } = await import('../src/lib/api');
		codeStep(vi.fn(async () => { throw new ApiError(400, 'That code is not right. 4 tries left.', { code: 'code_wrong' }); }));
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('6-digit code'), '000000');
		expect(await screen.findByText('That code is not right. 4 tries left.')).toBeInTheDocument();
		expect(screen.getByLabelText('6-digit code')).toHaveValue('');
	});
});

describe('links sent before codes', () => {
	it('an old confirmation link says to sign in or create the account again, and sends nothing', async () => {
		const { calls } = renderApp(
			<Routes>
				<Route path="/welcome/:token" element={<WelcomePage />} />
			</Routes>,
			{ role: null, status: HOSTED, route: `/welcome/${TOKEN}` },
		);
		expect(await screen.findByRole('heading', { name: 'This link is no longer used' })).toBeInTheDocument();
		expect(screen.getByText('Ready Set Mail now confirms email addresses with a 6-digit code instead of a link.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/');
		expect(screen.getByRole('link', { name: 'Create your account' })).toHaveAttribute('href', '/signup');
		expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});
});

describe('names render clean', () => {
	it('control and invisible characters are removed, and length is capped', () => {
		expect(cleanName('A‮evil\u0000 ​name\n\tx')).toBe('A evil name x');
		expect([...cleanName('x'.repeat(200))]).toHaveLength(80);
		expect(cleanName(null)).toBe('');
	});

	it('a member\'s stored name with a bidi override shows as plain text', async () => {
		renderApp(<MembersPage />, {
			role: 'owner',
			routes: {
				'GET /api/team': { users: [{ id: 'u2', email: 'x@example.com', name: 'Eve\u202Etxt.exe', role: 'member', last_login_at: null, created_at: 1 }], current_user_id: 'o1' },
				'GET /api/team/invites': { invites: [] },
			},
		});
		await waitFor(() => expect(screen.getByText('Eve txt.exe')).toBeInTheDocument());
		expect(screen.queryByText(/‮/)).toBeNull();
	});
});
