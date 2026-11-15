// "Wrong address? Start over" on the sign-up screens: the server drops the pending attempt and the form is empty again.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { renderApp } from './render';

describe('Use a different email, and starting over', () => {
	it('after sign-up, "Start over" drops the attempt and returns to an empty sign-up form', async () => {
		let pending = true;
		const { calls } = renderApp(<AuthPage initialMode="signup" />, {
			role: null,
			route: '/signup/code',
			status: { mode: 'saas', signup_open: true, configured: true },
			routes: {
				'GET /api/auth/signup/pending': () => (pending ? { pending: true, email: 'new@example.com', step: 'code', expires_in: 500, lifetime_seconds: 600 } : { pending: false }),
				'POST /api/auth/signup/cancel': () => ((pending = false), { ok: true }),
			},
		});
		const user = userEvent.setup();
		await screen.findByRole('heading', { name: 'Check your inbox' });
		await user.click(screen.getByRole('button', { name: 'Start over' }));
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
		expect(screen.getByLabelText('Work email')).toHaveValue('');
		expect(calls.some((c) => c.path === '/api/auth/signup/cancel')).toBe(true);
	});
});
