// "Use a different email" on the code screen goes back to the form that sent the code, with the address kept to edit.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { renderApp } from './render';

describe('Use a different email', () => {
	it('after sign-up, goes back to the sign-up form with the address to edit', async () => {
		renderApp(<AuthPage initialMode="signup" />, {
			role: null,
			status: { mode: 'saas', signup_open: true, configured: true },
			routes: { 'POST /api/auth/signup': { code_required: true, purpose: 'signup', email: 'new@example.com', expires_in: 600 } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'new@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to new@example.com' });
		await user.click(screen.getByRole('button', { name: 'Use a different email' }));
		expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
		expect(screen.getByLabelText('Email')).toHaveValue('new@example.com');
	});
});
