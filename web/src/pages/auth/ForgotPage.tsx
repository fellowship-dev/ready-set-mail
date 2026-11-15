import { Button, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout, Field } from './AuthLayout';
import { CodeStep, needsCode, type CodeRequired } from './CodeStep';
import { PasswordInput } from './PasswordInput';
import { useHumanCheck } from './Turnstile';

/**
 * Reset by code: the email, then one screen with the emailed code and the new password. Saving it signs in (no second code)
 * and ends every other session. The answer is the same whether or not the address has an account.
 */
export function ForgotPage() {
	const { status, signedIn } = useSession();
	const navigate = useNavigate();
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [pending, setPending] = useState<CodeRequired | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const check = useHumanCheck(status?.turnstile_site_key);

	const request = (token: string | null) => api<CodeRequired>('/api/auth/forgot', { method: 'POST', body: { email, ...(token ? { cf_turnstile_token: token } : {}) } });

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		setBusy(true);
		try {
			const res = await request(check.token);
			if (needsCode(res)) setPending(res);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
			check.reset(); // a token is single use
		}
	}

	if (pending) {
		return (
			<CodeStep
				email={pending.email}
				purpose="reset"
				submitLabel="Set password and sign in"
				extra={
					<Field id="new-password" label="New password" hint="At least 8 characters.">
						<PasswordInput id="new-password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="new-password-hint" />
					</Field>
				}
				onSubmit={async (code) => {
					if (password.length < 8) throw new Error('Choose a new password of at least 8 characters.');
					await api('/api/auth/reset', { method: 'POST', body: { code, password } });
					await signedIn();
					navigate('/', { replace: true });
				}}
				onResend={async (token) => {
					const res = await request(token);
					if (needsCode(res)) setPending(res);
				}}
				onChangeEmail={() => setPending(null)}
			/>
		);
	}

	return (
		<AuthLayout title="Reset password" description="Enter your email. We'll send you a 6-digit code, and you'll choose a new password.">
			<form onSubmit={submit} className="space-y-4">
				<Field id="email" label="Email">
					<Input id="email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.com" />
				</Field>
				{check.widget}
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy} disabled={!check.ready}>
					Send code
				</Button>
			</form>
			<Link to="/login" className="text-sm text-brand-ink underline underline-offset-4">
				Back to sign in
			</Link>
		</AuthLayout>
	);
}
