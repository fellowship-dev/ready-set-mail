import { Alert, Button, FieldError, FieldHint, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
import { useId, useState, type FormEvent } from 'react';
import { CopyField } from '../../../components/domain/CopyField';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { WriteButton } from '../../../components/states';
import { errorMessage } from '../../../lib/api';
import {
	ENCRYPTION_COMMAND,
	ENCRYPTION_MESSAGE,
	isEncryptionMissing,
	useAddToken,
	useStartOAuth,
	type CfConnection,
	type CfConnections,
} from '../../../lib/cloudflare';
import { tokenLink } from '../../../lib/cloudflare-token-link';
import { isAgency } from '../../../lib/first-run';
import { useHosted, useSession } from '../../../lib/session';


/** Step 1: OAuth when the instance offers it, otherwise a pasted API token. A failure is shown inline, never as a toast. */
export function ConnectStep({ offer, returnError, onConnected }: { offer: CfConnections | undefined; returnError?: string | null; onConnected: (c: CfConnection) => void }) {
	const hosted = useHosted();
	const { me } = useSession();
	const agency = isAgency(me?.whose_email);
	const start = useStartOAuth();
	const add = useAddToken();
	const tokenId = useId();
	const hintId = useId();
	const [token, setToken] = useState('');

	const noOffer = offer && !offer.oauth.available && !offer.token_paste;

	function goToCloudflare() {
		// The callback redirects to `<path>?cf_connection=…#<hash route>`; return_to is the route we are on.
		start.mutate(
			{ returnTo: `/${window.location.hash}` },
			{ onSuccess: (r) => window.location.assign(r.authorize_url) },
		);
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!token.trim()) return;
		add.mutate(token.trim(), {
			onSuccess: (r) => {
				setToken('');
				onConnected(r.connection);
			},
		});
	}

	if (noOffer) {
		return (
			<StepCard title="Connect Cloudflare">
				<div className="space-y-3">
					<p className="text-sm text-ink-2">{hosted ? 'Cloudflare cannot be connected on this service yet.' : ENCRYPTION_MESSAGE}</p>
					{hosted ? null : <CopyField label="Command" value={ENCRYPTION_COMMAND} />}
				</div>
			</StepCard>
		);
	}

	const startError = start.isError ? (isEncryptionMissing(start.error) ? ENCRYPTION_MESSAGE : errorMessage(start.error)) : '';
	if (offer?.oauth.available) {
		return (
			<StepCard title="Connect Cloudflare">
				<div className="space-y-4">
					<p className="max-w-prose text-sm text-ink-2">{hosted ? `You approve access at Cloudflare, then come back here. ${scopeSentence(agency)}` : 'You approve access at Cloudflare, then come back here. Ready Set Mail only writes in the zones you choose next.'}</p>
					{returnError ? <Alert variant="danger">{returnError}</Alert> : null}
					{startError ? <FieldError>{startError}</FieldError> : null}
					<StepFooter
						end={
							<WriteButton onClick={goToCloudflare} loading={start.isPending}>
								{start.isPending ? 'Opening Cloudflare…' : 'Continue to Cloudflare'}
							</WriteButton>
						}
					/>
				</div>
			</StepCard>
		);
	}

	const error = add.isError ? (isEncryptionMissing(add.error) ? ENCRYPTION_MESSAGE : errorMessage(add.error)) : '';
	return (
		<StepCard title="Connect Cloudflare">
			<form onSubmit={submit} className="space-y-5" noValidate>
				<div className="max-w-prose space-y-3 text-sm text-ink-2">
					<p className="font-medium text-ink-1">1. Create the token</p>
					<div>
						<Button asChild variant="secondary">
							<a href={tokenLink(hosted)} target="_blank" rel="noopener noreferrer">
								Create the token in Cloudflare
							</a>
						</Button>
					</div>
					<p>Cloudflare&apos;s page opens with Zone Read and DNS Edit already chosen.</p>
					{hosted ? <p>{scopeSentence(agency)}</p> : null}
					<details className="group">
						<summary className="cursor-pointer text-ink-2 underline underline-offset-4">What this token can do, and creating it by hand</summary>
						<div className="mt-3 space-y-3">
							<p>You can narrow the token to specific zones on Cloudflare&apos;s page before you create it.</p>
							{hosted ? null : (
								<p>
									Add these two by hand, Cloudflare&apos;s link cannot pre-fill them: Zone · Email Routing Rules · Edit (for the reports mailbox) and Account · Email Routing
									Addresses · Edit (for alert emails to you).
								</p>
							)}
							<p>
								In Cloudflare, create a token at <span className="font-mono text-xs">dash.cloudflare.com/profile/api-tokens</span> with these permissions:
							</p>
							<Table label="Token permissions">
								<TableHeader>
									<TableRow>
										<TableHead>Scope</TableHead>
										<TableHead>Group</TableHead>
										<TableHead>Permission</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									<PermissionRow scope="Zone" group="Zone" access="Read" />
									<PermissionRow scope="Zone" group="DNS" access="Edit" />
									<PermissionRow scope="Zone" group="Email Routing Rules" access="Edit" />
									{hosted ? null : <PermissionRow scope="Account" group="Email Routing Addresses" access="Edit" note="alert emails to you" />}
									<PermissionRow scope="Account" group="Account Settings" access="Read" />
								</TableBody>
							</Table>
							<p>Zone Resources: the zones you want Ready Set Mail to manage.</p>
							<p>
								It writes only the DMARC, report-authorisation and reports-mailbox records you approve{hosted ? '' : ', and only in the zones you choose'}, never SPF or DKIM records without showing you the change first. The token is stored encrypted; remove it here or revoke it at Cloudflare at any time.
							</p>
						</div>
					</details>
					<p className="font-medium text-ink-1">2. Paste it here</p>
				</div>
				<div className="max-w-md space-y-1.5">
					<Label htmlFor={tokenId}>Cloudflare API token</Label>
					<Input
						id={tokenId}
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={token}
						onChange={(e) => setToken(e.target.value)}
						aria-describedby={hintId}
						aria-invalid={error ? true : undefined}
					/>
					<FieldHint id={hintId}>Paste the token once. It is checked with Cloudflare before it is saved.</FieldHint>
					{error ? <FieldError>{error}</FieldError> : null}
				</div>
				<StepFooter
					end={
						<WriteButton type="submit" loading={add.isPending} disabled={!token.trim()}>
							{add.isPending ? 'Connecting…' : 'Connect'}
						</WriteButton>
					}
				/>
			</form>
		</StepCard>
	);
}

/** What connecting does, true of the hosted import: which zones are added, and that nothing is written before Apply. */
export const scopeSentence = (agency: boolean): string =>
	`${agency ? 'Only the zone of the client domain you are setting up is added and watched.' : 'Every active zone in the account is added and watched.'} Nothing is written to DNS until you press Apply on a change you have seen.`;

function PermissionRow({ scope, group, access, note }: { scope: string; group: string; access: string; note?: string }) {
	return (
		<TableRow>
			<TableCell>{scope}</TableCell>
			<TableCell>
				{group}
				{note ? <span className="text-ink-2"> ({note})</span> : null}
			</TableCell>
			<TableCell>{access}</TableCell>
		</TableRow>
	);
}

