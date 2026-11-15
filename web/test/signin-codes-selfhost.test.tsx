import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { SELF_HOST_CODES_DOC } from '../src/pages/auth/CodeStep';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { CODES_OFF_FOR_ME, CODES_TURNED_ON, SigninCodesForMe } from '../src/pages/settings/SigninCodes';
import { renderApp } from './render';

beforeEach(() => localStorage.clear());

const SELF = { mode: 'self-host', configured: true, signin_codes: true, signin_codes_reason: 'mail', signin_code_sender_domain: 'reports.acme.test', turnstile_site_key: null } as any;
const HOSTED = { mode: 'saas', configured: true, signup_open: true, signin_codes: true, signin_codes_reason: 'hosted', turnstile_site_key: null } as any;
const CODE = { code_required: true, purpose: 'signin', email: 'owner@acme.test', expires_in: 600 };

async function signInToCode(status: any) {
	renderApp(<AuthPage />, { role: null, status, routes: { 'POST /api/auth/login': CODE } });
	const user = userEvent.setup();
	await user.type(await screen.findByLabelText('Email'), 'owner@acme.test');
	await user.type(screen.getByLabelText('Password'), 'correct-horse');
	await user.click(screen.getByRole('button', { name: 'Sign in' }));
	await screen.findByLabelText('6-digit code');
}

describe('self-hosted sign-in when the instance can send codes', () => {
	it('says before the password that a code is emailed once turned on, and from which domain', async () => {
		renderApp(<AuthPage />, { role: null, status: SELF });
		const line = await screen.findByText(/If you turned on sign-in codes in Settings/);
		expect(line).toHaveTextContent('If you turned on sign-in codes in Settings, a 6-digit code is emailed to your address after your password, from an address at reports.acme.test.');
	});

	it('says nothing about codes when the instance cannot send them', async () => {
		renderApp(<AuthPage />, { role: null, status: { ...SELF, signin_codes: false, signin_codes_reason: 'no_mail', signin_code_sender_domain: undefined } });
		await screen.findByLabelText('Email');
		expect(screen.queryByText(/sign-in codes/)).toBeNull();
	});

	it('the code screen has one quiet line for a locked-out owner: SIGNIN_CODES=off and the self-hosting guide', async () => {
		await signInToCode(SELF);
		expect(screen.getByText(/Code never arrives\?/)).toHaveTextContent('Code never arrives? Whoever runs this instance can turn codes off with SIGNIN_CODES=off: self-hosting guide.');
		const link = screen.getByRole('link', { name: 'self-hosting guide' });
		expect(link).toHaveAttribute('href', SELF_HOST_CODES_DOC);
		expect(SELF_HOST_CODES_DOC).toBe('https://github.com/fellowship-dev/ready-set-mail/blob/main/docs/self-hosting.md#sign-in-codes');
	});

	it('hosted: neither the sentence nor the line', async () => {
		await signInToCode(HOSTED);
		expect(screen.queryByText(/Code never arrives\?/)).toBeNull();
		expect(screen.queryByText(/SIGNIN_CODES/)).toBeNull();
		expect(screen.queryByText(/If you turned on sign-in codes/)).toBeNull();
	});
});

describe('Settings: sign-in codes for me (self-host)', () => {
	it('off until a test code is entered; then on, and it says so', async () => {
		let on = false;
		const { calls } = renderApp(<SigninCodesForMe />, {
			role: 'owner',
			status: SELF,
			routes: {
				'GET /api/auth/codes': () => ({ available: true, reason: 'mail', on_for_me: on }),
				'POST /api/auth/codes/test': { code_required: true, purpose: 'confirm', email: 'owner@example.com', expires_in: 600 },
				'POST /api/auth/codes/confirm': () => ((on = true), { ok: true, on_for_me: true }),
			},
		});
		expect(await screen.findByText(CODES_OFF_FOR_ME)).toBeInTheDocument();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Send me a test code' }));
		expect(await screen.findByText(/Enter the code we just emailed you\. Once it is in, every sign-in here ends with a code like this one\./)).toBeInTheDocument();
		expect(screen.queryByText(/Code never arrives\?/)).toBeNull(); // the break-glass line is for the sign-in screen
		expect(screen.getByRole('button', { name: 'Turn on sign-in codes' })).toBeInTheDocument();
		await user.type(screen.getByLabelText('6-digit code'), '123456'); // the sixth digit submits
		expect(await screen.findByText(CODES_TURNED_ON)).toBeInTheDocument();
		await waitFor(() => expect(calls.find((c) => c.path === '/api/auth/codes/confirm')?.body).toEqual({ code: '123456' }));
	});

	it('a test code that cannot be sent shows the server sentence and leaves codes off', async () => {
		renderApp(<SigninCodesForMe />, {
			role: 'owner',
			status: SELF,
			routes: {
				'GET /api/auth/codes': { available: true, reason: 'mail', on_for_me: false },
				'POST /api/auth/codes/test': { __status: 503, body: { error: "We couldn't send a code to owner@example.com. This instance may not be able to deliver mail to that address, so sign-in codes stay off for you." } },
			},
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Send me a test code' }));
		expect(await screen.findByText(/This instance may not be able to deliver mail to that address/)).toBeInTheDocument();
		expect(screen.getByText(CODES_OFF_FOR_ME)).toBeInTheDocument();
	});

	it('shows nothing when codes cannot be used here', async () => {
		renderApp(<SigninCodesForMe />, { role: 'owner', status: SELF, routes: { 'GET /api/auth/codes': { available: false, reason: 'no_mail', on_for_me: false } } });
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByRole('button', { name: 'Send me a test code' })).toBeNull();
	});
});

describe('an old emailed link', () => {
	it('tells a person who never chose a password to reset it (signing up again would not work for a confirmed address)', async () => {
		renderApp(<WelcomePage />, { role: null });
		expect(await screen.findByText(/If you didn't, reset your password: we'll email you a code and you'll choose one\./)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Reset your password' })).toHaveAttribute('href', '/forgot');
		expect(screen.queryByRole('link', { name: 'Create your account' })).toBeNull();
	});
});
