import { Button, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useClaimLink } from '../../lib/claim-link';
import { useSession } from '../../lib/session';
import { HostedAlternative } from '../../components/HostedAlternative';
import { AuthLayout, Field } from '../auth/AuthLayout';
import { useHumanCheck } from '../auth/Turnstile';

const SETUP_TOKEN = /^(\d{1,12})\.[A-Za-z0-9_-]{43}$/;
const CLOCK_GRACE_SECONDS = 60;
export const EXPIRED_LINK = 'This setup link has expired. Run `npm run setup -- --new-link` to get a new one.';

/** A held setup token is usable when it is well formed and its expiry is not past (client clock, with a minute of grace). */
export function setupTokenUsable(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
	const m = SETUP_TOKEN.exec(token);
	return !!m && Number(m[1]) + CLOCK_GRACE_SECONDS > nowSeconds;
}

/**
 * First run on a self-hosted instance (no owner yet): create the owner account. The setup link the installer prints
 * (`#/setup?t=<expiry>.<sig>`) is held in memory by the Gate and carries the proof; without one the person is told where
 * to find it, and an installer proof (BOOTSTRAP_SECRET) stays available for instances set up that way.
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
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	/** The server refused the held link: it is shown as expired, whatever the reason. */
	const [refused, setRefused] = useState(false);
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
			// Setup opens the owner's session at once, with no emailed code (first-owner setup is self-host only).
			const res = await api<{ has_domain?: boolean }>('/api/auth/setup', {
				method: 'POST',
				body: { name, email, password, ...turnstile },
				headers: { 'X-Ready-Set-Mail-Bootstrap': linkToken ?? bootstrapProof },
			});
			setBootstrapProof('');
			claim.clear();
			await signedIn();
			// A new owner with no domain yet goes straight to the setup wizard.
			navigate(res.has_domain === false ? '/setup' : '/', { replace: true });
		} catch (err) {
			if (linkToken && err instanceof ApiError && err.status === 403) setRefused(true);
			else if (err instanceof ApiError && err.status === 403 && /installer proof/i.test(err.message)) setError('That installer proof was not accepted. Paste the exact BOOTSTRAP_SECRET value set on the Worker. If none was set yet, the person who deployed it needs to set one first.');
			else setError(errorMessage(err));
		} finally {
			setBusy(false);
			check.reset(); // a token is single use
		}
	}

	if (linkToken && (refused || !setupTokenUsable(linkToken))) {
		return (
			<AuthLayout title="Setup link">
				<p className="text-sm text-ink-1">{EXPIRED_LINK}</p>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout
			title={linkToken ? 'Create the owner account' : 'Create your account'}
			description={linkToken ? undefined : 'This creates the account that owns this instance. It needs the setup link printed when you deployed, or an installer proof. There is no default password.'}
		>
			<form onSubmit={submit} className="space-y-4">
				{!linkToken ? (
					<>
						<p className="text-sm text-ink-2">Open the setup link printed when you installed, or run <code className="font-mono">npm run setup</code> again to get a new one.</p>
						<details open={proofOpen} onToggle={(e) => setProofOpen(e.currentTarget.open)}>
							<summary className="cursor-pointer text-sm text-brand-ink underline underline-offset-4">I have an installer proof</summary>
							<div className="pt-4">
								<Field id="bootstrap-proof" label="Installer proof" hint="The BOOTSTRAP_SECRET value set on the Worker before its first start. The setup guide keeps it in a private file, such as ~/.config/ready-set-mail/<name>/bootstrap-proof. It works once. Never paste it into an agent chat."><Input id="bootstrap-proof" type="password" minLength={32} autoComplete="off" value={bootstrapProof} onChange={(e) => setBootstrapProof(e.target.value)} /></Field>
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
