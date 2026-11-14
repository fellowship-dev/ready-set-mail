import { Button, Checkbox, FieldError, Input, Label } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useClaimLink } from '../../lib/claim-link';
import { useSession } from '../../lib/session';
import { HostedAlternative } from '../../components/HostedAlternative';
import { AuthLayout, Field } from '../auth/AuthLayout';
import { CheckEmail } from '../auth/CheckEmail';
import { useHumanCheck } from '../auth/Turnstile';

/**
 * First run on a self-hosted instance (no owner yet): create the owner account. The setup link printed at deploy
 * (`#/claim/<token>`) is the proof; without one the person is told where to find it, and an installer proof
 * (BOOTSTRAP_SECRET) stays available for instances set up that way.
 */
export function OwnerSetupPage() {
	const { status, signedIn } = useSession();
	const navigate = useNavigate();
	const claim = useClaimLink();
	const linkToken = claim.token;
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [bootstrapProof, setBootstrapProof] = useState('');
	const [proofOpen, setProofOpen] = useState(false);
	const [telemetry, setTelemetry] = useState(status?.telemetry_default ?? false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [verifyFor, setVerifyFor] = useState<string | null>(null);
	const check = useHumanCheck(status?.turnstile_site_key);

	if (!status) return null;

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError('');
		if (password.length < 8) return setError('Password must be at least 8 characters.');
		if (password !== confirm) return setError('Passwords do not match.');
		if (!linkToken && bootstrapProof.length < 32) {
			setProofOpen(true);
			return setError(bootstrapProof ? 'Installer proof must be at least 32 characters.' : 'Open the setup link printed when you deployed, or enter an installer proof.');
		}
		setBusy(true);
		try {
			const turnstile = check.token ? { cf_turnstile_token: check.token } : {};
			const res = await api<{ verification_required?: boolean; has_domain?: boolean }>('/api/auth/setup', {
				method: 'POST',
				body: { name, email, password, telemetry, ...turnstile },
				headers: { 'X-Ready-Set-Mail-Bootstrap': linkToken ?? bootstrapProof },
			});
			setBootstrapProof('');
			claim.clear();
			if (res.verification_required) {
				setVerifyFor(email);
				return;
			}
			await signedIn();
			// A new owner with no domain yet goes straight to the setup wizard.
			navigate(res.has_domain === false ? '/setup' : '/', { replace: true });
		} catch (err) {
			if (err instanceof ApiError && err.status === 403 && (err.body as { code?: string } | undefined)?.code === 'email_not_verified') setVerifyFor(email);
			else if (linkToken && err instanceof ApiError && err.status === 403) setError('This setup link has expired or was already used. Run `npm run setup-link` where you deployed to get a new one.');
			else if (err instanceof ApiError && err.status === 403 && /installer proof/i.test(err.message)) setError('That installer proof was not accepted. Paste the exact BOOTSTRAP_SECRET value set on the Worker. If none was set yet, the person who deployed it needs to set one first.');
			else setError(errorMessage(err));
		} finally {
			setBusy(false);
			check.reset(); // a token is single use
		}
	}

	if (verifyFor) return <CheckEmail email={verifyFor} onBack={() => { setVerifyFor(null); setError(''); }} />;

	return (
		<AuthLayout
			title={linkToken ? 'Create the owner account' : 'Create your account'}
			description={linkToken ? undefined : 'This creates the account that owns this instance. It needs the setup link printed when you deployed, or an installer proof. There is no default password.'}
		>
			<form onSubmit={submit} className="space-y-4">
				{!linkToken ? (
					<>
						<p className="text-sm text-ink-2">Open the setup link printed when you deployed (it is also in the deploy log), or run <code className="font-mono">npm run setup-link</code>.</p>
						<details open={proofOpen} onToggle={(e) => setProofOpen(e.currentTarget.open)}>
							<summary className="cursor-pointer text-sm text-brand-ink underline underline-offset-4">I have an installer proof</summary>
							<div className="pt-4">
								<Field id="bootstrap-proof" label="Installer proof" hint="The BOOTSTRAP_SECRET value set on the Worker before its first start. The setup guide keeps it in a private file, such as ~/.config/ready-set-mail/bootstrap-proof. It works once. Never paste it into an agent chat."><Input id="bootstrap-proof" type="password" minLength={32} autoComplete="off" value={bootstrapProof} onChange={(e) => setBootstrapProof(e.target.value)} /></Field>
							</div>
						</details>
					</>
				) : null}
				<Field id="name" label="Your name (optional)">
					<Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Jane Smith" />
				</Field>
				<Field id="email" label="Email" hint="Used to sign in and to receive monitoring alerts.">
					<Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@yourcompany.com" aria-describedby="email-hint" />
				</Field>
				<Field id="password" label="Password" hint="At least 8 characters.">
					<Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" aria-describedby="password-hint" />
				</Field>
				<Field id="confirm" label="Confirm password">
					<Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
				</Field>
				<div className="flex items-start gap-3">
					<Checkbox id="telemetry" checked={telemetry} onCheckedChange={(v) => setTelemetry(v === true)} className="mt-0.5" />
					<Label htmlFor="telemetry" className="font-normal leading-snug">
						<strong className="font-semibold">Share anonymous usage stats.</strong>{' '}
						<span className="text-ink-2">Feature usage counts only: no personal data, email addresses or domain names. You can change this later.</span>
					</Label>
				</div>
				{linkToken ? <p className="text-sm text-ink-2">This link works once.</p> : null}
				{check.widget}
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy} disabled={!check.ready}>
					Create account
				</Button>
			</form>
			<HostedAlternative url={status.hosted_service_url} />
		</AuthLayout>
	);
}
