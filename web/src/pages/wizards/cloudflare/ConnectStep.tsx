import { Alert, FieldError, FieldHint, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
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
import { useHosted } from '../../../lib/session';

const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

/** Step 1: OAuth when the instance offers it, otherwise a pasted API token. A failure is shown inline, never as a toast. */
export function ConnectStep({ offer, returnError, onConnected }: { offer: CfConnections | undefined; returnError?: string | null; onConnected: (c: CfConnection) => void }) {
	const hosted = useHosted();
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
					<p className="max-w-prose text-sm text-ink-2">You approve access at Cloudflare, then come back here. Ready Set Mail only writes in the zones you choose next.</p>
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
					<p>
						<a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-4">
							Create a token at Cloudflare
						</a>{' '}
						with these permissions:
					</p>
				</div>
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
						{hosted ? null : <PermissionRow scope="Account" group="Email Routing Addresses" access="Edit" note="the reports mailbox" />}
						<PermissionRow scope="Account" group="Account Settings" access="Read" />
					</TableBody>
				</Table>
				<div className="max-w-prose space-y-3 text-sm text-ink-2">
					<p>Zone Resources: the zones you want Ready Set Mail to manage.</p>
					<p>
						It writes only the DMARC, report-authorisation and reports-mailbox records you approve on the next screens, and only in the zones you choose. It never touches other
						records, and never writes SPF or DKIM records without showing you the change first. The token is stored encrypted; remove it here or revoke it at Cloudflare at any
						time.
					</p>
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

