import { cleanName } from '../../lib/names';
import { Badge, Button, Card, CardContent, CardFooter, FieldError, Input, PageHeader, Skeleton, toast } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ReadOnlyNotice, Section, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useHosted, useSession } from '../../lib/session';
import { setTheme, useTheme } from '../../lib/theme';
import { Field } from '../auth/AuthLayout';
import { DangerZone } from './DangerZone';
import { WorkspaceSection } from './WorkspaceSection';
import { BillingSection } from './BillingSection';
import { EmailSection } from './EmailSection';
import { AgentConnectionsSection } from './AgentConnectionsSection';
import { MetricConnectionsSection } from './MetricConnectionsSection';
import { CloudflareSection } from './CloudflareSection';
import { SetupCheck } from '../../components/SetupCheck';
import { LegalLinks, useLegal } from '../auth/LegalLinks';
import { SigninCodesForMe } from './SigninCodes';

/** How people sign in here, in one plain sentence (GET /api/auth/status signin_codes_reason). */
export function signinModeText(reason: string | undefined): string | null {
	if (reason === 'hosted') return 'Password, then a 6-digit code emailed at every sign-in.';
	if (reason === 'mail') return 'Password, then a 6-digit code emailed at every sign-in, for each person once a test code has reached them.';
	if (reason === 'no_mail') return "Password only. This instance can't send email, so sign-in codes are off. Set up outbound email (the SEND_EMAIL binding and a sender address) to turn them on.";
	if (reason === 'turned_off') return 'Password only. Sign-in codes are turned off on this instance (SIGNIN_CODES=off).';
	return null;
}

interface VersionInfo {
	current: string;
	latest: string | null;
	status?: 'newer' | 'same' | 'older' | 'unknown' | 'off';
	update_available: boolean;
	release_url: string;
	upgrade_url?: string;
}

/** What the update check found, in words. "Could not check" is never shown as "up to date". */
function versionNote(v: VersionInfo): React.ReactNode {
	const status = v.status ?? (v.update_available ? 'newer' : v.latest && v.latest === v.current ? 'same' : 'unknown');
	if (status === 'newer' && v.latest) {
		return (
			<>
				<a className="text-brand-ink underline underline-offset-4" href={v.release_url} target="_blank" rel="noreferrer">
					v{v.latest} available
				</a>
				{v.upgrade_url ? (
					<>
						{' · '}
						<a className="text-brand-ink underline underline-offset-4" href={v.upgrade_url} target="_blank" rel="noreferrer">
							How to upgrade
						</a>
					</>
				) : null}
			</>
		);
	}
	if (status === 'same') return <span className="text-ink-2">(up to date)</span>;
	if (status === 'older') return <span className="text-ink-2">(newer than the latest release, v{v.latest})</span>;
	if (status === 'off') return <span className="text-ink-2">(update check off)</span>;
	return <span className="text-ink-2">(could not check for updates)</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
			<dt className="text-sm text-ink-2">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-ink-1">{children}</dd>
		</div>
	);
}

export function SettingsPage() {
	const { me, role, status, signOut } = useSession();
	const { theme } = useTheme();
	const hosted = useHosted();
	const qc = useQueryClient();
	const signinMode = signinModeText((status as { signin_codes_reason?: string } | null | undefined)?.signin_codes_reason);
	const legal = useLegal();
	const version = useQuery({ queryKey: ['version'], queryFn: () => api<VersionInfo>('/api/version'), staleTime: 3_600_000, retry: false });

	const customDomain = useMutation({
		mutationFn: () => api<{ hostname: string }>('/api/setup/custom-domain', { method: 'POST' }),
		onSuccess: async ({ hostname }) => {
			toast({ variant: 'success', title: 'Custom domain registered', description: hostname });
			await qc.invalidateQueries({ queryKey: ['auth-status'] });
		},
	});

	return (
		<div className="space-y-8">
			<PageHeader title="Settings" description={hosted ? 'Your account and workspace.' : 'Your account and this Ready Set Mail instance.'} />
			<ReadOnlyNotice />

			<Section title="Account">
				<Card>
					<CardContent className="py-2">
						<dl className="divide-y divide-line">
							<Row label="Name">{me?.user ? cleanName(me.user.name) || me.user.email : 'Instance API key'}</Row>
							<Row label="Email">{me?.user?.email ?? 'Not tied to a user'}</Row>
							<Row label="Role">{role ? <Badge variant="brand">{role}</Badge> : null}</Row>
							{signinMode ? <Row label="Sign-in">{signinMode}{!hosted && me?.user ? <SigninCodesForMe /> : null}</Row> : null}
						</dl>
					</CardContent>
					<CardFooter className="justify-end">
						<Button variant="secondary" onClick={() => void signOut()}>
							<LogOut aria-hidden />
							Sign out
						</Button>
					</CardFooter>
				</Card>
				{me?.user ? <ChangePassword /> : null}
			</Section>

			<WorkspaceSection />

			<BillingSection />

			<EmailSection />

			<CloudflareSection />
			<AgentConnectionsSection />
			<MetricConnectionsSection />

			<Section title="Appearance" description="Follows your system until you choose.">
				<Card>
					<CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
						<p className="text-sm text-ink-2">Theme</p>
						<div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
							<Button variant={theme === 'light' ? 'primary' : 'secondary'} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
								<Sun aria-hidden />
								Light
							</Button>
							<Button variant={theme === 'dark' ? 'primary' : 'secondary'} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
								<Moon aria-hidden />
								Dark
							</Button>
						</div>
					</CardContent>
				</Card>
			</Section>

			{hosted ? null : (
			<Section title="Instance">
				<SetupCheck />
				<Card>
					<CardContent className="py-2">
						<dl className="divide-y divide-line">
							<Row label="Version">
								{version.isPending ? (
									<Skeleton className="h-4 w-24" />
								) : version.isError ? (
									<span className="text-ink-2">Could not check for updates</span>
								) : (
									<>
										v{version.data.current} {versionNote(version.data)}
									</>
								)}
							</Row>
							<Row label="Mode">{status?.mode === 'saas' ? 'Hosted' : 'Self-hosted'}</Row>
							<Row label="Base domain">{status?.base_domain ?? <span className="text-ink-2">Not set: the setup wizard sets it.</span>}</Row>
							<Row label="Dashboard address">
								{status?.custom_domain ? (
									<a className="text-brand-ink underline underline-offset-4" href={`https://${status.custom_domain}`}>
										{status.custom_domain}
									</a>
								) : (
									<span className="flex flex-wrap items-center gap-3">
										<span className="text-ink-2">Using the default workers.dev address.</span>
										{status?.base_domain ? (
											<WriteButton size="sm" variant="secondary" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]" loading={customDomain.isPending} onClick={() => customDomain.mutate()}>
												Use ready-set-mail.{status.base_domain}
											</WriteButton>
										) : null}
									</span>
								)}
							</Row>
							<Row label="Usage analytics">{status?.product_analytics ? 'On: a few steps are counted with a random number in place of your account. Never your email address, domains, DNS records or IP address.' : 'Off: this installation sends no usage analytics.'}</Row>
						</dl>
					</CardContent>
				</Card>
				{customDomain.isError ? <FieldError>{errorMessage(customDomain.error)}</FieldError> : null}
			</Section>
			)}

			<DangerZone />

			{status?.mode === 'saas' ? (
				<footer className="space-y-2 border-t border-line pt-6 text-center text-xs text-ink-2">
					{legal?.operator_name ? <p>Ready Set Mail is operated by {legal.operator_name}</p> : null}
					<LegalLinks />
				</footer>
			) : null}
		</div>
	);
}

function ChangePassword() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const change = useMutation({
		mutationFn: () => api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } }),
		onSuccess: () => {
			setCurrent('');
			setNext('');
			setConfirm('');
			toast({ variant: 'success', title: 'Password changed', description: 'Other devices were signed out. Your API keys still work: revoke them if you are worried about one.' });
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (next.length < 8) return setError('New password must be at least 8 characters.');
		if (next !== confirm) return setError('Passwords do not match.');
		change.mutate();
	}

	return (
		<Card>
			<CardContent className="space-y-4">
				<h3 className="font-semibold">Change password</h3>
				<form onSubmit={submit} className="grid max-w-md gap-4">
					<Field id="current-password" label="Current password">
						<Input id="current-password" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
					</Field>
					<Field id="new-password" label="New password" hint="At least 8 characters. Other devices are signed out.">
						<Input id="new-password" type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="new-password-hint" />
					</Field>
					<Field id="confirm-password" label="Confirm new password">
						<Input id="confirm-password" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
					</Field>
					{error || change.isError ? <FieldError>{error || errorMessage(change.error)}</FieldError> : null}
					<div>
						<Button type="submit" loading={change.isPending}>
							Change password
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

