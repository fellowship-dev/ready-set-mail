import { Alert, Button, FieldError, Input, Label } from '@ready-set-mail/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { forgetSignupEmail, setPendingSignup, SIGNUP_PATH, SIGNUP_PENDING_KEY, type PendingSignup } from '../../lib/signup';
import { AuthLayout } from './AuthLayout';
import { codeDigits, CODE_MINUTES, needsCode } from './CodeStep';
import { useHumanCheck } from './Turnstile';

type Pending = Extract<PendingSignup, { pending: true }>;

/** "Wrong address? Start over": the server drops the attempt (and its answers), and nothing is waiting any more. */
export async function startOver(qc: QueryClient): Promise<void> {
	await api('/api/auth/signup/cancel', { method: 'POST', body: {} }).catch(() => {});
	forgetSignupEmail();
	setPendingSignup(qc, { pending: false });
}

/** The words for a refused code (the server's own wording names a different path for sign-in). */
/** The refusal after which only a new code helps: the code is spent or expired, so "Send a new code" is shown right there. */
const needsNewCode = (err: unknown) => {
	const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
	return code === 'code_used_up' || code === 'code_expired';
};

export function refusal(err: unknown): string {
	const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
	if (code === 'code_wrong') return "That code isn't right. Check the latest email.";
	if (code === 'code_expired') return 'That code has expired. Send a new code.';
	if (code === 'code_used_up') return "That code can't be used any more. Send a new code.";
	return errorMessage(err);
}

/**
 * S3, "Check your inbox". One input (not six boxes: paste, autofill and screen readers keep working): numeric keypad, the
 * browser's one-time-code autofill, spaces and hyphens ignored, and the sixth digit submits on its own, with the button as the
 * fallback. Resending and the bot check hide behind "Not seeing it?"; the check is not on the page before that.
 *
 * One screen for every hosted code that confirms an address: sign-up (SignupCode) and an invitation (InvitePage). What differs is passed in:
 * what a right code does, how a new one is asked for, and whether "Wrong address? Start over" makes sense (not for an invited address).
 */
export function CodeScreen({ email, minutes, onSubmit, onResend, onStartOver }: {
	email: string;
	minutes: number;
	/** A right code: do what follows. Throw to show the refusal. */
	onSubmit: (code: string) => Promise<void>;
	/** Ask for a new code. Resolve false when the screen has been left (nothing to announce). */
	onResend: (token: string | null) => Promise<boolean | void>;
	onStartOver?: () => Promise<void>;
}) {
	const { status } = useSession();
	const [code, setCode] = useState('');
	const [error, setError] = useState('');
	const [spent, setSpent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [help, setHelp] = useState(false);
	const [resend, setResend] = useState<'idle' | 'sending' | 'sent'>('idle');
	const [resendError, setResendError] = useState('');
	const check = useHumanCheck(status?.turnstile_site_key, { execution: 'execute', appearance: 'interaction-only', size: 'flexible' });
	const input = useRef<HTMLInputElement>(null);
	const submitted = useRef('');

	useEffect(() => {
		input.current?.focus();
	}, []);

	async function submit(value: string) {
		if (value.length !== 6 || busy) return;
		submitted.current = value;
		setError('');
		setBusy(true);
		try {
			await onSubmit(value);
		} catch (err) {
			setError(refusal(err));
			setSpent(needsNewCode(err));
			submitted.current = '';
			setCode('');
			input.current?.focus();
			setBusy(false);
		}
	}

	function change(raw: string) {
		const next = codeDigits(raw);
		setCode(next);
		if (next.length === 6 && next !== submitted.current) void submit(next);
	}

	async function sendNew() {
		setResend('sending');
		setResendError('');
		try {
			const token = await check.run();
			if (status?.turnstile_site_key && !token) throw new Error('The human check did not pass. Try again.');
			if ((await onResend(token ?? null)) === false) return;
			setResend('sent');
			setCode('');
			submitted.current = '';
			setError('');
			setSpent(false);
			input.current?.focus();
		} catch (err) {
			setResendError(errorMessage(err));
			setResend('idle');
		} finally {
			check.reset(); // a token is single use
		}
	}

	/** "Send a new code" sits under the error when only a new code helps (and keeps its answer there); otherwise it is behind "Not seeing it?". */
	const quick = spent || (!help && resend === 'sent');
	const resendBlock = (
		<>
			{resend === 'sent' ? <p role="status">A new code is on its way. The previous one no longer works.</p> : null}
			<p>
				<button type="button" className="text-brand-ink underline underline-offset-4 disabled:opacity-50" disabled={resend === 'sending'} onClick={() => void sendNew()}>
					{resend === 'sending' ? 'Sending…' : 'Send a new code'}
				</button>
			</p>
			{/* Only now, and only drawn if Cloudflare needs a click. */}
			{check.widget}
			{resendError ? <Alert variant="danger" className="text-left">{resendError}</Alert> : null}
		</>
	);

	return (
		<AuthLayout title="Check your inbox" description={<>We sent a 6-digit code to <span className="[overflow-wrap:anywhere]">{email}</span>. It's valid for {minutes} minutes.</>}>
			<form
				className="space-y-4"
				noValidate
				onSubmit={(e: FormEvent) => {
					e.preventDefault();
					void submit(code);
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="code" className="sr-only">
						6-digit code
					</Label>
					<Input
						ref={input}
						id="code"
						name="code"
						type="text"
						inputMode="numeric"
						autoComplete="one-time-code"
						pattern="\d{6}"
						maxLength={14}
						spellCheck={false}
						value={code}
						onChange={(e) => change(e.target.value)}
						aria-describedby={error ? 'code-error' : undefined}
						aria-invalid={error ? true : undefined}
						className="mx-auto block h-16 w-[13.5rem] max-w-full px-2 text-center font-mono text-3xl tracking-[0.45em] focus-visible:border-2 focus-visible:border-brand"
					/>
					{error ? <FieldError id="code-error" className="text-center">{error}</FieldError> : null}
				</div>
				<Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
					Continue
				</Button>
			</form>

			<div className="space-y-3 text-center text-sm">
				{quick ? <div className="space-y-2 text-ink-2" data-testid="send-new-code">{resendBlock}</div> : null}
				<button type="button" className="text-brand-ink underline underline-offset-4" aria-expanded={help} aria-controls="not-seeing-it" onClick={() => setHelp((h) => !h)}>
					Not seeing it?
				</button>
				{help ? (
					<div id="not-seeing-it" className="space-y-2 text-ink-2">
						<p>Emails can take a few minutes. Check your spam folder.</p>
						{quick ? null : resendBlock}
					</div>
				) : null}
				{onStartOver ? (
					<p className="text-ink-2">
						Wrong address?{' '}
						<button type="button" className="text-brand-ink underline underline-offset-4" onClick={() => void onStartOver()}>
							Start over
						</button>
					</p>
				) : null}
			</div>
		</AuthLayout>
	);
}

/** S3 of the sign-up: a right code opens the session and goes to the app; "Send a new code" is the pending attempt's own resend. */
export function SignupCode({ pending }: { pending: Pending }) {
	const { signedIn } = useSession();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const minutes = Math.max(1, Math.round((pending.lifetime_seconds ?? CODE_MINUTES * 60) / 60));
	return (
		<CodeScreen
			email={pending.email}
			minutes={minutes}
			onSubmit={async (value) => {
				await api('/api/auth/code', { method: 'POST', body: { code: value } });
				forgetSignupEmail();
				qc.removeQueries({ queryKey: SIGNUP_PENDING_KEY });
				await signedIn();
				navigate('/', { replace: true });
			}}
			onResend={async (token) => {
				try {
					const res = await api<unknown>('/api/auth/signup/resend', { method: 'POST', body: token ? { cf_turnstile_token: token } : {} });
					if (!needsCode(res)) throw new Error('Something went wrong. Try again.');
				} catch (err) {
					if (err instanceof ApiError && err.status === 410) {
						// The attempt ended: nothing is waiting any more, so start again at S1.
						setPendingSignup(qc, { pending: false });
						navigate(SIGNUP_PATH.form, { replace: true });
						return false;
					}
					throw err;
				}
			}}
			onStartOver={async () => {
				await startOver(qc);
				navigate(SIGNUP_PATH.form, { replace: true });
			}}
		/>
	);
}
