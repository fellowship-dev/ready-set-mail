import { Alert, Button, FieldError, Input, Label } from '@ready-set-mail/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';
import { useHumanCheck } from './Turnstile';

/** How long a code works (src/auth/codes.ts CODE_MINUTES). */
export const CODE_MINUTES = 10;

export type CodePurpose = 'signup' | 'invite' | 'signin' | 'reset';

/** The server's answer to a form that ends with an emailed code. */
export interface CodeRequired {
	code_required: true;
	purpose: CodePurpose;
	email: string;
}
export const needsCode = (r: unknown): r is CodeRequired => !!r && typeof r === 'object' && (r as { code_required?: unknown }).code_required === true;

/** The plain sentence above the code input: what this screen is for. */
export const CODE_PURPOSE_TEXT: Record<CodePurpose, string> = {
	signup: 'This confirms your email address. Once the code is in, your account is ready and you are signed in.',
	invite: 'This confirms your email address. Once the code is in, you are signed in and join the workspace.',
	signin: 'Your password was right. Enter the code from the email to finish signing in.',
	reset: 'Enter the code from the email and choose a new password. Then you are signed in.',
};

/** Keep the digits of whatever was typed or pasted ("123 456", "123-456"), at most six. */
export const codeDigits = (raw: string): string => raw.replace(/\D/g, '').slice(0, 6);

interface CodeFormProps {
	email: string;
	purpose: CodePurpose;
	/** Check the code (and whatever `extra` holds). Throw to show the error. */
	onSubmit: (code: string) => Promise<void>;
	/** Ask for a new code: repeat the request that sent this one, with a fresh bot-check token when the instance has one. */
	onResend: (turnstileToken: string | null) => Promise<void>;
	/** Back to the form, to change the address. */
	onChangeEmail?: () => void;
	/** Extra fields under the code (a new password, for a reset). With them, the sixth digit moves on instead of submitting. */
	extra?: ReactNode;
	submitLabel?: string;
}

/**
 * The code input and its actions, without the page frame (InvitePage shows it inline). One input: six digits, the numeric
 * keypad on phones, the browser's one-time-code autofill, paste in any format; the sixth digit submits.
 * The bot check is needed only for "Send a new code", so it appears only once that is used, under it.
 */
export function CodeForm({ email, purpose, onSubmit, onResend, onChangeEmail, extra, submitLabel = 'Continue' }: CodeFormProps) {
	const { status } = useSession();
	const [code, setCode] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [resend, setResend] = useState<'idle' | 'checking' | 'sending' | 'sent'>('idle');
	const [resendError, setResendError] = useState('');
	const check = useHumanCheck(status?.turnstile_site_key);
	const input = useRef<HTMLInputElement>(null);
	const submitted = useRef('');

	async function submit(value: string) {
		if (value.length !== 6 || busy) return;
		submitted.current = value;
		setError('');
		setBusy(true);
		try {
			await onSubmit(value);
		} catch (err) {
			setError(errorMessage(err));
			submitted.current = '';
			setCode('');
			input.current?.focus();
		} finally {
			setBusy(false);
		}
	}

	function change(raw: string) {
		const next = codeDigits(raw);
		setCode(next);
		if (next.length === 6 && next !== submitted.current) {
			if (extra) document.getElementById('code-extra')?.querySelector('input')?.focus();
			else void submit(next);
		}
	}

	async function sendNew(token: string | null) {
		setResend('sending');
		setResendError('');
		try {
			await onResend(token);
			setResend('sent');
			setCode('');
			submitted.current = '';
			setError('');
			input.current?.focus();
		} catch (err) {
			setResendError(errorMessage(err));
			setResend('idle');
		} finally {
			check.reset(); // a token is single use
		}
	}

	// With a bot check, "Send a new code" first shows the check; the new code is asked for as soon as it is solved.
	useEffect(() => {
		if (resend === 'checking' && check.token) void sendNew(check.token);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resend, check.token]);

	function askForNew() {
		if (check.widget) setResend('checking');
		else void sendNew(null);
	}

	return (
		<div className="space-y-5">
			<p className="text-sm text-ink-1">
				{CODE_PURPOSE_TEXT[purpose]} The code expires in {CODE_MINUTES} minutes.
			</p>
			<form
				className="space-y-4"
				onSubmit={(e: FormEvent) => {
					e.preventDefault();
					void submit(code);
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="code">6-digit code</Label>
					<Input
						ref={input}
						id="code"
						name="code"
						autoFocus
						inputMode="numeric"
						autoComplete="one-time-code"
						pattern="[0-9]*"
						maxLength={14}
						value={code}
						onChange={(e) => change(e.target.value)}
						aria-describedby={error ? 'code-error' : undefined}
						aria-invalid={error ? true : undefined}
						className="h-14 text-center font-mono text-2xl tracking-[0.4em]"
					/>
					{error ? <FieldError id="code-error">{error}</FieldError> : null}
				</div>
				{extra ? <div id="code-extra">{extra}</div> : null}
				<Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
					{submitLabel}
				</Button>
			</form>

			<div className="space-y-3 border-t border-line pt-4">
				{resend === 'sent' ? <p className="text-sm text-ink-2" role="status">A new code is on its way to {email}. The previous code no longer works.</p> : null}
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
					<Button type="button" variant="secondary" loading={resend === 'sending'} disabled={resend === 'checking'} onClick={askForNew}>
						Send a new code
					</Button>
					{onChangeEmail ? (
						<button type="button" className="text-brand-ink underline underline-offset-4" onClick={onChangeEmail}>
							Use a different email
						</button>
					) : null}
				</div>
				{resend === 'checking' ? check.widget : null}
				{resendError ? <Alert variant="danger">{resendError}</Alert> : null}
				<p className="text-xs text-ink-2">No email after a few minutes? Check your spam folder, then send a new code.</p>
			</div>
		</div>
	);
}

/** The whole "Enter the 6-digit code we sent to <email>" screen. */
export function CodeStep(props: CodeFormProps) {
	return (
		<AuthLayout title={`Enter the 6-digit code we sent to ${props.email}`}>
			<CodeForm {...props} />
		</AuthLayout>
	);
}
