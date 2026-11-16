import { Alert, Button, FieldError, Input } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { bindSignupDomainToEmail } from '../../lib/signup-intent';
import { signupAnalytics } from '../../lib/signup-source';
import { useSession } from '../../lib/session';
import { EMAIL_PATTERN, readSignupEmail, rememberSignupEmail, screenFor, setPendingSignup, SIGNUP_PATH, stepOfPath, usePendingSignup, type PendingSignup } from '../../lib/signup';
import { PageSkeleton } from '../../components/states';
import { AuthLayout, Field } from './AuthLayout';
import { needsCode } from './CodeStep';
import { PasswordInput } from './PasswordInput';
import { TermsAgreement } from './LegalLinks';
import { useHumanCheck } from './Turnstile';
import { SignupAbout } from './SignupAbout';
import { SignupCode } from './SignupCode';

/**
 * Hosted sign-up, three screens: S1 here (email and password), S2 (SignupAbout), S3 (SignupCode). The code email is sent when S1
 * is submitted and travels while S2 is filled in. What the server says about this browser's pending attempt picks the screen, so
 * a reload, a returning tab or a back button never starts again at S1 while an attempt is waiting; "Start over" drops it.
 */
export function SignupFlow({ onSignIn }: { onSignIn: () => void }) {
	const { pathname } = useLocation();
	const pendingQ = usePendingSignup();
	const asked = stepOfPath(pathname);
	if (pendingQ.isPending) return <AuthLayout title="Loading…"><PageSkeleton label="Loading" /></AuthLayout>;
	// A failed lookup is treated as "nothing waiting": the form still works, and the server decides on submit.
	const pending = pendingQ.data;
	const right = screenFor(pending);
	// S1 while an attempt waits → its screen; S2/S3 with nothing waiting → S1; S3 before S2 is saved → S2. (S2 stays open once
	// saved: the answers can be corrected while the code travels.)
	if (asked === 'form' && right !== 'form') return <Navigate to={SIGNUP_PATH[right]} replace />;
	if (asked !== 'form' && right === 'form') return <Navigate to={SIGNUP_PATH.form} replace />;
	if (asked === 'code' && right === 'about') return <Navigate to={SIGNUP_PATH.about} replace />;
	if (asked === 'form') return <SignupForm onSignIn={onSignIn} />;
	const waiting = pending as Extract<PendingSignup, { pending: true }>;
	return asked === 'about' ? <SignupAbout pending={waiting} /> : <SignupCode pending={waiting} />;
}

/** S1: email and password. The bot check runs on Continue and shows only if Cloudflare needs a click. */
function SignupForm({ onSignIn }: { onSignIn: () => void }) {
	const { status } = useSession();
	const navigate = useNavigate();
	const qc = useQueryClient();
	// A sign-up that ended (its code expired while S2 was open, or the tab came back later): S1 says so and keeps the address.
	const [expiredFor] = useState(() => readSignupEmail());
	const [email, setEmail] = useState(expiredFor ?? '');
	const [password, setPassword] = useState('');
	const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
	const [busy, setBusy] = useState(false);
	const check = useHumanCheck(status?.turnstile_site_key, { execution: 'execute', appearance: 'interaction-only', size: 'flexible' });
	useEffect(() => {
		document.getElementById(expiredFor ? 'password' : 'email')?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const next: typeof errors = {};
		if (!EMAIL_PATTERN.test(email.trim())) next.email = 'Enter an email address like name@company.com';
		if (password.length < 8) next.password = 'Use at least 8 characters';
		setErrors(next);
		if (next.email || next.password) {
			document.getElementById(next.email ? 'email' : 'password')?.focus();
			return;
		}
		setBusy(true);
		try {
			bindSignupDomainToEmail(email);
			const token = await check.run();
			if (status?.turnstile_site_key && !token) return setErrors({ form: 'The human check did not pass. Try again.' });
			const res = await api<unknown>('/api/auth/signup', { method: 'POST', body: { email: email.trim(), password, ...(token ? { cf_turnstile_token: token } : {}), ...signupAnalytics() } });
			if (!needsCode(res)) return setErrors({ form: 'Something went wrong. Try again.' });
			rememberSignupEmail(email);
			setPendingSignup(qc, { pending: true, email: res.email, step: 'about', expires_in: (res as { expires_in?: number }).expires_in ?? 600, lifetime_seconds: (res as { expires_in?: number }).expires_in });
			navigate(SIGNUP_PATH.about);
		} catch (err) {
			const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
			setErrors({ form: code === 'code_not_sent' ? "We couldn't send email to this address just now. Check it, or try again in a minute." : errorMessage(err) });
		} finally {
			setBusy(false);
			check.reset(); // a token is single use
		}
	}

	return (
		<AuthLayout title="Create your account" description="Check and fix your domain's SPF, DKIM and DMARC.">
			<form onSubmit={submit} className="space-y-4" noValidate>
				{expiredFor ? (
					<Alert variant="warning" data-testid="signup-expired">
						Your sign-up for {expiredFor} timed out, so its code no longer works. Enter your password again and we'll send a new code.
					</Alert>
				) : null}
				<Field id="email" label="Work email">
					<Input
						id="email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						autoComplete="email"
						placeholder="you@yourcompany.com"
						aria-invalid={errors.email ? true : undefined}
						aria-describedby={errors.email ? 'email-error' : undefined}
					/>
					{errors.email ? <FieldError id="email-error">{errors.email}</FieldError> : null}
				</Field>
				<Field id="password" label="Password" hint={errors.password ? undefined : 'At least 8 characters.'}>
					<PasswordInput
						id="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
						autoComplete="new-password"
						aria-invalid={errors.password ? true : undefined}
						aria-describedby={errors.password ? 'password-error' : 'password-hint'}
					/>
					{errors.password ? <FieldError id="password-error">{errors.password}</FieldError> : null}
				</Field>
				{errors.form ? <Alert variant="danger">{errors.form}</Alert> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Continue
				</Button>
				{/* Under the button, and only drawn when Cloudflare needs a click. */}
				{check.widget}
				<TermsAgreement />
			</form>
			<p className="text-center text-sm text-ink-2">
				Already have an account?{' '}
				<button type="button" className="text-brand-ink underline underline-offset-4" onClick={onSignIn}>
					Sign in
				</button>
			</p>
		</AuthLayout>
	);
}
