// Hosted sign-up, S1 → S2 → S3: what each screen asks and does, how the URL and the server's state choose the screen, and how
// the bot check runs on S1 (unseen, on Continue) and on S3 (only after "Not seeing it?").
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '../src/lib/types';
import type { PendingSignup } from '../src/lib/signup';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { __resetTurnstileLoaderForTests } from '../src/pages/auth/Turnstile';
import { fail, me, renderApp } from './render';

const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, turnstile_site_key: null, legal: { terms_url: 'https://readysetmail.com/terms', privacy_url: 'https://readysetmail.com/privacy', operator_name: 'Fellowship.dev, Inc.' } } as Partial<AuthStatus>;
const WITH_CHECK: Partial<AuthStatus> = { ...HOSTED, turnstile_site_key: '1x00000000000000000000AA' };
const EMAIL = 'dana@brightwave-mail.com';
const SENT = { code_required: true, purpose: 'signup', email: EMAIL, expires_in: 600 };
const ABOUT_PENDING: PendingSignup = { pending: true, email: EMAIL, step: 'about', expires_in: 590, lifetime_seconds: 600 };
const PROFILE = { name: 'Dana Whitfield', organization: 'Brightwave Studio', whose_email: 'company' as const };
const CODE_PENDING: PendingSignup = { pending: true, email: EMAIL, step: 'code', expires_in: 500, lifetime_seconds: 600, profile: PROFILE };

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

function Where() {
	return <output data-testid="where">{useLocation().pathname}</output>;
}

/** The sign-up routes of the app, on one memory router, with a stateful stand-in for the server's pending attempt. */
function flow(opts: { route?: string; pending?: PendingSignup; status?: Partial<AuthStatus>; routes?: Record<string, unknown> } = {}) {
	let pending: PendingSignup = opts.pending ?? { pending: false };
	const api = renderApp(
		<>
			<Routes>
				<Route path="/signup/*" element={<AuthPage initialMode="signup" />} />
				<Route path="/" element={<p>home</p>} />
			</Routes>
			<Where />
		</>,
		{
			role: null,
			route: opts.route ?? '/signup',
			status: opts.status ?? HOSTED,
			routes: {
				'GET /api/auth/signup/pending': () => pending,
				'POST /api/auth/signup': () => ((pending = { pending: true, email: EMAIL, step: 'about', expires_in: 600, lifetime_seconds: 600 }), SENT),
				'POST /api/auth/signup/profile': ({ body }: { body: any }) => ((pending = { ...(pending as any), step: 'code', profile: body }), { ok: true, step: 'code' }),
				'POST /api/auth/signup/cancel': () => ((pending = { pending: false }), { ok: true }),
				...opts.routes,
			},
		},
	);
	return { ...api, setPending: (p: PendingSignup) => (pending = p) };
}
const where = () => screen.getByTestId('where').textContent;

/** A stand-in for Cloudflare's script: `execute` plays the widget's callback after a tick, unless `interactive`. */
function fakeTurnstile(mode: 'pass' | 'interactive' | 'fail' = 'pass') {
	const widgets: Array<{ el: HTMLElement; opts: any; id: string }> = [];
	const api = {
		render: vi.fn((el: HTMLElement, opts: any) => {
			const id = `w${widgets.length + 1}`;
			widgets.push({ el, opts, id });
			return id;
		}),
		execute: vi.fn((id: string) => {
			const w = widgets.find((x) => x.id === id)!;
			if (mode === 'pass') queueMicrotask(() => act(() => w.opts.callback('tok-1')));
			if (mode === 'fail') queueMicrotask(() => act(() => w.opts['error-callback']()));
			if (mode === 'interactive') queueMicrotask(() => act(() => w.opts['before-interactive-callback']()));
		}),
		reset: vi.fn(),
		remove: vi.fn(),
	};
	window.turnstile = api as any;
	const solve = () => act(() => widgets[widgets.length - 1]!.opts.callback('tok-1'));
	return { api, widgets, solve };
}
afterEach(() => {
	delete window.turnstile;
	__resetTurnstileLoaderForTests();
});

describe('S1: email and password', () => {
	it('asks for the work email and a password, one Continue, the legal line under it, and a way to sign in', async () => {
		flow();
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
		expect(screen.getByText("Check and fix your domain's SPF, DKIM and DMARC.")).toBeInTheDocument();
		const email = screen.getByLabelText('Work email');
		expect(email).toHaveAttribute('type', 'email');
		expect(email).toHaveAttribute('autocomplete', 'email');
		expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
		expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
		const agreement = screen.getByText(/By creating an account you agree to the/);
		expect(screen.getByRole('button', { name: 'Continue' }).compareDocumentPosition(agreement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByText('or continue with')).toBeNull(); // email and password only
		expect(screen.queryByLabelText(/name/i)).toBeNull();
	});

	it('names the field that is wrong, in words tied to it, and sends nothing', async () => {
		const { calls } = flow();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), 'dana');
		await user.type(screen.getByLabelText('Password'), 'short');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		const email = screen.getByLabelText('Work email');
		expect(email).toHaveAttribute('aria-invalid', 'true');
		expect(email).toHaveAccessibleDescription('Enter an email address like name@company.com');
		await user.clear(email);
		await user.type(email, EMAIL);
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(/At least 8 characters\..*Use at least 8 characters|Use at least 8 characters/);
		expect(calls.some((c) => c.path === '/api/auth/signup')).toBe(false);
	});

	it('sends the code on Continue and goes straight to S2 (the person is told nothing about the email yet)', async () => {
		const { calls } = flow();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
		expect(where()).toBe('/signup/about');
		expect(calls.find((c) => c.path === '/api/auth/signup')?.body).toEqual({ email: EMAIL, password: 'long-enough-1' });
		expect(screen.queryByText(/sent|inbox/i)).toBeNull();
	});

	it('a refused send stays on S1 with the plain sentence', async () => {
		flow({ routes: { 'POST /api/auth/signup': { __status: 503, body: { error: "We couldn't send the code. Try again in a minute.", code: 'code_not_sent' } } } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't send email to this address just now. Check it, or try again in a minute.");
		expect(where()).toBe('/signup');
	});

	it('the bot check runs unseen on Continue (execution: execute, interaction-only, flexible), then its token is sent', async () => {
		const t = fakeTurnstile('pass');
		const { calls } = flow({ status: WITH_CHECK });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		const button = screen.getByRole('button', { name: 'Continue' });
		expect(button).toBeEnabled(); // not waiting for a check that has not started
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		expect(t.api.render.mock.calls[0]![1]).toMatchObject({ sitekey: WITH_CHECK.turnstile_site_key, execution: 'execute', appearance: 'interaction-only', size: 'flexible' });
		expect(t.api.execute).not.toHaveBeenCalled(); // nothing runs before the person presses Continue
		expect(screen.queryByText(/One more check from Cloudflare/)).toBeNull();
		expect(screen.queryByText(/Waiting for the human check/)).toBeNull();
		await user.click(button);
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
		expect(t.api.execute).toHaveBeenCalledTimes(1);
		expect(calls.find((c) => c.path === '/api/auth/signup')?.body).toEqual({ email: EMAIL, password: 'long-enough-1', cf_turnstile_token: 'tok-1' });
		expect(t.api.reset).toHaveBeenCalled(); // a token is single use
	});

	it('if Cloudflare needs a click, one plain line appears with the widget, and the form continues once it is solved', async () => {
		const t = fakeTurnstile('interactive');
		const { calls } = flow({ status: WITH_CHECK });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('One more check from Cloudflare, then we continue.')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/auth/signup')).toBe(false);
		await t.solve();
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
		expect(screen.queryByText('One more check from Cloudflare, then we continue.')).toBeNull();
	});

	it('a check that did not pass sends nothing and says so', async () => {
		fakeTurnstile('fail');
		const { calls } = flow({ status: WITH_CHECK });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/did not pass/);
		expect(calls.some((c) => c.path === '/api/auth/signup')).toBe(false);
	});
});

describe('S2: tell us about yourself', () => {
	const open = (extra: Parameters<typeof flow>[0] = {}) => flow({ route: '/signup/about', pending: ABOUT_PENDING, ...extra });

	it('names the account, asks the fields in order, with the fork as three radio cards and one Continue', async () => {
		open();
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
		expect(screen.getByText(EMAIL)).toBeInTheDocument();
		const labels = ['Your name', 'Organization name', 'Whose email are you setting up?', 'What is your role? (optional)', 'Where did you hear about us? (optional)'];
		const found = labels.map((l) => (l.startsWith('Whose') ? screen.getByText(l) : screen.getByText(l)));
		for (let i = 1; i < found.length; i++) expect(found[i - 1]!.compareDocumentPosition(found[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByLabelText('Organization name')).toHaveAttribute('placeholder', 'e.g. Brightwave Studio');
		expect(screen.getByLabelText('Organization name')).toHaveValue(''); // never prefilled
		const group = screen.getByRole('radiogroup', { name: 'Whose email are you setting up?' });
		expect(within(group).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(["My company's", "My clients' (I'm an agency or IT provider)", 'Just looking around']);
		expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
		expect(screen.getByLabelText('Where did you hear about us? (optional)')).toHaveAttribute('placeholder', 'A colleague, a search, a post…');
	});

	it('requires name, organization and the fork, and says which', async () => {
		const { calls } = open();
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Continue' }));
		expect(screen.getByLabelText('Your name')).toHaveAccessibleDescription('Enter your name');
		expect(screen.getByLabelText('Organization name')).toHaveAccessibleDescription('Enter your organization name');
		expect(screen.getByRole('radiogroup', { name: 'Whose email are you setting up?' })).toHaveAttribute('aria-invalid', 'true');
		expect(screen.getByText("Choose whose email you're setting up")).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/auth/signup/profile')).toBe(false);
	});

	it('saves the answers to the pending attempt and moves on to the code; role and heard-about are optional', async () => {
		const { calls } = open();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), PROFILE.name);
		await user.type(screen.getByLabelText('Organization name'), PROFILE.organization);
		await user.click(screen.getByLabelText("My company's"));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
		expect(where()).toBe('/signup/code');
		expect(calls.find((c) => c.path === '/api/auth/signup/profile')?.body).toEqual(PROFILE);
	});

	it('sends the role and the heard-about text when given', async () => {
		const { calls } = open();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), 'Sam Ortiz');
		await user.type(screen.getByLabelText('Organization name'), 'Northside IT');
		await user.click(screen.getByLabelText("My clients' (I'm an agency or IT provider)"));
		await user.type(screen.getByLabelText('Where did you hear about us? (optional)'), ' A colleague ');
		await user.click(screen.getByRole('combobox', { name: 'What is your role? (optional)' }));
		await user.click(await screen.findByRole('option', { name: 'Agency or consultant' }));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Check your inbox' });
		expect(calls.find((c) => c.path === '/api/auth/signup/profile')?.body).toEqual({ name: 'Sam Ortiz', organization: 'Northside IT', whose_email: 'clients', role: 'agency', heard_about: 'A colleague' });
	});

	it('stops typing at the server bounds', async () => {
		open();
		expect(await screen.findByLabelText('Your name')).toHaveAttribute('maxlength', '100');
		expect(screen.getByLabelText('Organization name')).toHaveAttribute('maxlength', '80');
		expect(screen.getByLabelText('Where did you hear about us? (optional)')).toHaveAttribute('maxlength', '200');
	});

	it('shows a server refusal at the field it names', async () => {
		open({ routes: { 'POST /api/auth/signup/profile': { __status: 400, body: { error: 'Organization name must be at most 80 characters', field: 'organization' } } } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), 'Dana');
		await user.type(screen.getByLabelText('Organization name'), 'Brightwave');
		await user.click(screen.getByLabelText('Just looking around'));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await waitFor(() => expect(screen.getByLabelText('Organization name')).toHaveAccessibleDescription('Organization name must be at most 80 characters'));
	});

	it('an attempt that ended while the page was open goes back to S1', async () => {
		open({ routes: { 'POST /api/auth/signup/profile': { __status: 410, body: { error: 'expired', code: 'code_expired' } } } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), 'Dana');
		await user.type(screen.getByLabelText('Organization name'), 'Brightwave');
		await user.click(screen.getByLabelText('Just looking around'));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
	});

	it('returning with answers saved keeps them in the fields', async () => {
		flow({ route: '/signup/about', pending: CODE_PENDING });
		expect(await screen.findByLabelText('Your name')).toHaveValue('Dana Whitfield');
		expect(screen.getByLabelText('Organization name')).toHaveValue('Brightwave Studio');
		expect(screen.getByLabelText("My company's")).toBeChecked();
	});
});

describe('S3: check your inbox', () => {
	const open = (extra: Parameters<typeof flow>[0] = {}) => flow({ route: '/signup/code', pending: CODE_PENDING, ...extra });

	it('says where the code went and the real lifetime, and has one big code input', async () => {
		open();
		expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
		expect(screen.getByText(/It's valid for 10 minutes\./)).toHaveTextContent("We sent a 6-digit code to dana@brightwave-mail.com. It's valid for 10 minutes.");
		const input = screen.getByLabelText('6-digit code');
		expect(input.tagName).toBe('INPUT');
		expect(input).toHaveAttribute('type', 'text');
		expect(input).toHaveAttribute('inputmode', 'numeric');
		expect(input).toHaveAttribute('autocomplete', 'one-time-code');
		expect(input).toHaveAttribute('pattern', '\\d{6}');
		expect(input).toHaveFocus();
		expect(input.className).toMatch(/text-center/);
		expect(input.className).toMatch(/font-mono/);
		expect(document.querySelectorAll('input')).toHaveLength(1); // not six boxes
		expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
	});

	it('takes the lifetime from the server, not from a copy of the number', async () => {
		open({ pending: { ...CODE_PENDING, lifetime_seconds: 900 } as PendingSignup });
		expect(await screen.findByText(/It's valid for 15 minutes\./)).toBeInTheDocument();
	});

	it('submits on its own at the sixth digit, and signs in', async () => {
		let done = false;
		const { calls } = open({ routes: { 'POST /api/auth/code': () => ((done = true), { purpose: 'signup' }), 'GET /api/me': () => (done ? me('owner') : fail(401)) } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('6-digit code'), '482190');
		await waitFor(() => expect(calls.find((c) => c.path === '/api/auth/code')?.body).toEqual({ code: '482190' }));
		expect(await screen.findByText('home')).toBeInTheDocument();
		expect(calls.filter((c) => c.path === '/api/auth/code')).toHaveLength(1);
	});

	it.each([['123 456', '123456'], ['123-456', '123456'], [' 4 8 2 1 9 0 ', '482190']])('paste of "%s" is read as %s', async (pasted, expected) => {
		const { calls } = open({ routes: { 'POST /api/auth/code': fail(400, 'wrong') } });
		const user = userEvent.setup();
		await user.click(await screen.findByLabelText('6-digit code'));
		await user.paste(pasted);
		await waitFor(() => expect(calls.find((c) => c.path === '/api/auth/code')?.body).toEqual({ code: expected }));
	});

	it('shows the plain words for a wrong, expired and used-up code, tied to the input, and clears it', async () => {
		let n = 0;
		const answers = [
			{ __status: 400, body: { error: 'That code is not right. 4 tries left.', code: 'code_wrong' } },
			{ __status: 410, body: { error: 'This code has expired or was replaced by a newer one. Send a new code.', code: 'code_expired' } },
			{ __status: 410, body: { error: 'That code was entered wrong 5 times', code: 'code_used_up' } },
		];
		open({ routes: { 'POST /api/auth/code': () => answers[n++] } });
		const user = userEvent.setup();
		const input = await screen.findByLabelText('6-digit code');
		const expectMessage = async (text: string) => {
			await waitFor(() => expect(input).toHaveAccessibleDescription(text));
			expect(input).toHaveAttribute('aria-invalid', 'true');
			expect(input).toHaveValue('');
		};
		await user.type(input, '111111');
		await expectMessage("That code isn't right. Check the latest email.");
		await user.type(input, '222222');
		await expectMessage('That code has expired. Send a new code.');
		await user.type(input, '333333');
		await expectMessage("That code can't be used any more. Send a new code.");
	});

	it('the button submits too (the fallback)', async () => {
		const { calls } = open({ routes: { 'POST /api/auth/code': fail(400, 'wrong') } });
		const user = userEvent.setup();
		const input = await screen.findByLabelText('6-digit code');
		await user.type(input, '12345');
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
		await user.type(input, '6');
		await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/code')).toHaveLength(1));
	});

	it('"Not seeing it?" reveals spam advice and "Send a new code"; the bot check is not on the page before that', async () => {
		const t = fakeTurnstile('pass');
		const { calls } = open({ status: WITH_CHECK, routes: { 'POST /api/auth/signup/resend': SENT } });
		const user = userEvent.setup();
		const toggle = await screen.findByRole('button', { name: 'Not seeing it?' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('button', { name: 'Send a new code' })).toBeNull();
		expect(t.api.render).not.toHaveBeenCalled();
		expect(screen.queryByTestId('human-check')).toBeNull();
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByText('Emails can take a few minutes. Check your spam folder.')).toBeInTheDocument();
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		expect(t.api.execute).not.toHaveBeenCalled(); // not before the person asks for a new code
		await user.click(screen.getByRole('button', { name: 'Send a new code' }));
		expect(await screen.findByText('A new code is on its way. The previous one no longer works.')).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/signup/resend')?.body).toEqual({ cf_turnstile_token: 'tok-1' });
	});

	it('"Send a new code" is a link, not a second button-weight action', async () => {
		open({ routes: { 'POST /api/auth/signup/resend': SENT } });
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Not seeing it?' }));
		const send = screen.getByRole('button', { name: 'Send a new code' });
		expect(send.className).toMatch(/underline/);
		expect(send.className).not.toMatch(/\bbg-/);
	});

	it('"Wrong address? Start over" drops the attempt and shows an empty S1', async () => {
		const { calls } = open();
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Start over' }));
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
		expect(screen.getByLabelText('Work email')).toHaveValue('');
		expect(calls.some((c) => c.path === '/api/auth/signup/cancel')).toBe(true);
		expect(where()).toBe('/signup');
	});

	it('an expired attempt on a new-code request goes back to S1', async () => {
		open({ routes: { 'POST /api/auth/signup/resend': fail(410, 'expired') } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Not seeing it?' }));
		await user.click(screen.getByRole('button', { name: 'Send a new code' }));
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
	});
});

describe('the URL holds the step, and the server state picks the screen', () => {
	it.each([
		['/signup', { pending: false } as PendingSignup, 'Create your account', '/signup'],
		['/signup/about', { pending: false } as PendingSignup, 'Create your account', '/signup'],
		['/signup/code', { pending: false } as PendingSignup, 'Create your account', '/signup'],
		['/signup', ABOUT_PENDING, 'Tell us about yourself', '/signup/about'],
		['/signup/about', ABOUT_PENDING, 'Tell us about yourself', '/signup/about'],
		['/signup/code', ABOUT_PENDING, 'Tell us about yourself', '/signup/about'],
		['/signup', CODE_PENDING, 'Check your inbox', '/signup/code'],
		['/signup/code', CODE_PENDING, 'Check your inbox', '/signup/code'],
	])('opening %s with %j shows "%s" at %s (never back at step 1 while an attempt waits)', async (route, pending, heading, path) => {
		flow({ route, pending });
		expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
		expect(where()).toBe(path);
	});

	it('S2 stays reachable after it was saved (answers can be corrected while the code travels)', async () => {
		flow({ route: '/signup/about', pending: CODE_PENDING });
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
		expect(where()).toBe('/signup/about');
	});

	it('the whole walk: S1 → S2 → S3 → signed in', async () => {
		let done = false;
		const { calls } = flow({ routes: { 'POST /api/auth/code': () => ((done = true), { purpose: 'signup' }), 'GET /api/me': () => (done ? me('owner') : fail(401)) } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), EMAIL);
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await user.type(await screen.findByLabelText('Your name'), PROFILE.name);
		await user.type(screen.getByLabelText('Organization name'), PROFILE.organization);
		await user.click(screen.getByLabelText("My company's"));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await user.type(await screen.findByLabelText('6-digit code'), '482190');
		expect(await screen.findByText('home')).toBeInTheDocument();
		expect(calls.map((c) => c.path).filter((p) => p.startsWith('/api/auth/') && p !== '/api/auth/status' && p !== '/api/auth/signup/pending')).toEqual(['/api/auth/signup', '/api/auth/signup/profile', '/api/auth/code']);
	});
});

describe('S1 carries where the sign-up came from (analytics, categories only)', () => {
	it('src and from_checker go with the sign-up request; the domain itself is never in it', async () => {
		const { captureVisit, __resetVisitForTests } = await import('../src/lib/signup-source');
		captureVisit(new URLSearchParams('src=checker&domain=harbor-lane.org'));
		try {
			const { calls } = flow({ routes: { 'POST /api/auth/signup': SENT } });
			const user = userEvent.setup();
			await user.type(await screen.findByLabelText('Work email'), EMAIL);
			await user.type(screen.getByLabelText('Password', { exact: true }), 'long-enough-1');
			await user.click(screen.getByRole('button', { name: 'Continue' }));
			await waitFor(() => expect(calls.find((c) => c.path === '/api/auth/signup')?.body).toEqual({ email: EMAIL, password: 'long-enough-1', src: 'checker', from_checker: true }));
			expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('harbor-lane');
		} finally {
			__resetVisitForTests();
		}
	});
});
