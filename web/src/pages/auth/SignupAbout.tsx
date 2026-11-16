import { Alert, Button, FieldError, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { RadioCard } from '../../components/wizard/RadioCard';
import { PROFILE_LIMITS, ROLE_OPTIONS, setPendingSignup, SIGNUP_PATH, WHOSE_EMAIL_OPTIONS, type PendingSignup, type SignupProfile, type WhoseEmail } from '../../lib/signup';
import { AuthLayout, Field } from './AuthLayout';
import { startOver } from './SignupCode';

type Pending = Extract<PendingSignup, { pending: true }>;
type FieldName = 'name' | 'organization' | 'whose_email' | 'role' | 'heard_about';

/**
 * S2, "Tell us about yourself". Filled in while the code email travels. The answers are saved to the pending sign-up attempt on
 * the server (no account exists yet) and applied when the code is right. The fork, "Whose email are you setting up?", is the
 * only answer that changes what comes next.
 */
export function SignupAbout({ pending }: { pending: Pending }) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const saved = pending.profile;
	const [name, setName] = useState(saved?.name ?? '');
	const [organization, setOrganization] = useState(saved?.organization ?? '');
	const [whose, setWhose] = useState<WhoseEmail | ''>(saved?.whose_email ?? '');
	const [role, setRole] = useState(saved?.role ?? '');
	const [heard, setHeard] = useState(saved?.heard_about ?? '');
	const [errors, setErrors] = useState<Partial<Record<FieldName | 'form', string>>>({});
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		document.getElementById('name')?.focus();
	}, []);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const next: typeof errors = {};
		if (!name.trim()) next.name = 'Enter your name';
		if (!organization.trim()) next.organization = 'Enter your organization name';
		if (!whose) next.whose_email = "Choose whose email you're setting up";
		setErrors(next);
		const first = (['name', 'organization', 'whose_email'] as const).find((f) => next[f]);
		if (first) {
			document.getElementById(first === 'whose_email' ? 'whose-email-group' : first)?.focus();
			return;
		}
		setBusy(true);
		try {
			const body = { name: name.trim(), organization: organization.trim(), whose_email: whose, ...(role ? { role } : {}), ...(heard.trim() ? { heard_about: heard.trim() } : {}) };
			await api('/api/auth/signup/profile', { method: 'POST', body });
			setPendingSignup(qc, { ...pending, step: 'code', profile: body as SignupProfile });
			navigate(SIGNUP_PATH.code);
		} catch (err) {
			const body = err instanceof ApiError ? (err.body as { code?: string; field?: FieldName } | undefined) : undefined;
			if (err instanceof ApiError && (err.status === 410 || body?.code === 'code_expired')) {
				// The attempt ended while this page was open: nothing is waiting any more, so start again at S1.
				setPendingSignup(qc, { pending: false });
				navigate(SIGNUP_PATH.form, { replace: true });
				return;
			}
			if (body?.field) setErrors({ [body.field]: errorMessage(err) });
			else setErrors({ form: errorMessage(err) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<AuthLayout title="Tell us about yourself" description={<>Setting up the account for <span className="[overflow-wrap:anywhere]">{pending.email}</span></>}>
			<form onSubmit={submit} className="space-y-3" noValidate>
				<Field id="name" label="Your name">
					<Input
						id="name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						maxLength={PROFILE_LIMITS.name}
						autoComplete="name"
						aria-invalid={errors.name ? true : undefined}
						aria-describedby={errors.name ? 'name-error' : undefined}
					/>
					{errors.name ? <FieldError id="name-error">{errors.name}</FieldError> : null}
				</Field>
				<Field id="organization" label="Organization name">
					<Input
						id="organization"
						value={organization}
						onChange={(e) => setOrganization(e.target.value)}
						required
						maxLength={PROFILE_LIMITS.organization}
						autoComplete="organization"
						placeholder="e.g. Brightwave Studio"
						aria-invalid={errors.organization ? true : undefined}
						aria-describedby={errors.organization ? 'organization-error' : undefined}
					/>
					{errors.organization ? <FieldError id="organization-error">{errors.organization}</FieldError> : null}
				</Field>
				<fieldset className="space-y-1.5" aria-describedby={errors.whose_email ? 'whose-email-error' : undefined}>
					<legend className="text-sm font-medium leading-none text-ink-1">Whose email are you setting up?</legend>
					{/* The group is focusable for the error's sake; the radios keep the real focus order. */}
					<div id="whose-email-group" tabIndex={-1} role="radiogroup" aria-label="Whose email are you setting up?" aria-required="true" aria-invalid={errors.whose_email ? true : undefined} className="space-y-1.5 outline-none">
						{WHOSE_EMAIL_OPTIONS.map((o) => (
							<RadioCard key={o.value} name="whose-email" value={o.value} checked={whose === o.value} onChange={(v) => setWhose(v as WhoseEmail)} title={o.title} compact />
						))}
					</div>
					{errors.whose_email ? <FieldError id="whose-email-error">{errors.whose_email}</FieldError> : null}
				</fieldset>
				<Field id="role" label="What is your role? (optional)">
					<Select value={role} onValueChange={setRole}>
						<SelectTrigger id="role">
							<SelectValue placeholder="Choose one" />
						</SelectTrigger>
						<SelectContent>
							{ROLE_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.title}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field id="heard-about" label="Where did you hear about us? (optional)">
					<Input id="heard-about" value={heard} onChange={(e) => setHeard(e.target.value)} maxLength={PROFILE_LIMITS.heard_about} placeholder="A colleague, a search, a post…" aria-invalid={errors.heard_about ? true : undefined} aria-describedby={errors.heard_about ? 'heard-about-error' : undefined} />
					{errors.heard_about ? <FieldError id="heard-about-error">{errors.heard_about}</FieldError> : null}
				</Field>
				{errors.form ? <Alert variant="danger">{errors.form}</Alert> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Continue
				</Button>
			</form>
			<p className="text-center text-sm text-ink-2">
				Wrong address?{' '}
				<StartOverLink />
			</p>
		</AuthLayout>
	);
}

/** "Start over": drops the pending attempt on the server and returns to an empty S1. */
function StartOverLink() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			className="text-brand-ink underline underline-offset-4 disabled:opacity-50"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				await startOver(qc);
				navigate(SIGNUP_PATH.form, { replace: true });
			}}
		>
			Start over
		</button>
	);
}

