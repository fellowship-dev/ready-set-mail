import { Button, Card, CardContent, Skeleton } from '@ready-set-mail/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CopyField } from '../../../components/domain/CopyField';
import { ENCRYPTION_COMMAND, ENCRYPTION_MESSAGE, clearProgress, usableConnection, useCfConnections, writeProgress, type CfConnections } from '../../../lib/cloudflare';
import { useDomainClaims } from '../../../lib/queries';
import { useHosted, useSession } from '../../../lib/session';
import { DomainStep } from '../setup/DomainStep';

type Mode =
	| { kind: 'pending' }
	/** Today's domain form alone. */
	| { kind: 'plain' }
	/** Cloudflare can be offered: the primary block, the manual form behind a quiet link. */
	| { kind: 'chooser'; data: CfConnections }
	/** Self-host without a key to store a connection: how to set one, and the manual form beside it. */
	| { kind: 'blocked'; data: CfConnections };

const WILL_DO = ['Reads the zones in your Cloudflare account', 'Shows every record before anything is written', 'Writes them when you press the button'];

/**
 * The first screen of `#/setup` (no domain yet). Connecting Cloudflare is the obvious choice; "I'll add DNS records
 * myself" is a quiet button under it that reveals the domain form. Anything that cannot offer Cloudflare shows
 * today's domain form alone. `onProgress` says whether the five-step manual progress bar belongs on screen: only
 * once the manual form is.
 */
export function FirstScreen({ onDomainSet, onProgress }: { onDomainSet: (domainId: number) => void; onProgress?: (show: boolean) => void }) {
	const hosted = useHosted();
	const { canWrite, me } = useSession();
	const navigate = useNavigate();
	const manualRef = useRef<HTMLDivElement>(null);
	const [revealed, setRevealed] = useState(false);
	const claims = useDomainClaims();
	// Members cannot connect anything; skip the request instead of waiting for its 403.
	const conns = useCfConnections(canWrite);

	let mode: Mode;
	const data = conns.data;
	if (!canWrite) mode = { kind: 'plain' };
	else if (conns.isPending) mode = { kind: 'pending' };
	// Failing request, or hosted waiting for a DNS proof: exactly the form there always was.
	else if (conns.isError || !data) mode = { kind: 'plain' };
	else if (hosted && (claims.data ?? []).some((c) => c.status === 'pending')) mode = { kind: 'plain' };
	// Hosted: a customer cannot set the encryption key, so without it there is no Cloudflare path to offer.
	else if (hosted && !data.encryption_configured) mode = { kind: 'plain' };
	else if (!usableConnection(data) && !data.oauth.available && !data.token_paste) mode = hosted || data.encryption_configured ? { kind: 'plain' } : { kind: 'blocked', data };
	else mode = { kind: 'chooser', data };

	const showProgress = mode.kind === 'plain' || mode.kind === 'blocked' || (mode.kind === 'chooser' && revealed);
	useEffect(() => onProgress?.(showProgress), [showProgress, onProgress]);

	if (mode.kind === 'pending') return <Skeleton className="h-40 w-full" role="status" aria-label="Checking Cloudflare" />;
	if (mode.kind === 'plain') return <DomainStep onDomainSet={onDomainSet} />;

	const usable = usableConnection(mode.data);
	const workspace = me?.workspace_id ?? null;
	const toWizard = (step: 'connect' | 'domains') => {
		clearProgress(workspace);
		writeProgress(workspace, { step, domainIds: [], written: { domains: 0, records: 0 }, connectionId: usable?.id });
		navigate('/setup/cloudflare');
	};
	const manual = (
		<div ref={manualRef}>
			<DomainStep onDomainSet={onDomainSet} secondary={mode.kind === 'chooser'} title="I'll add DNS records myself" hideConnectLink />
		</div>
	);

	if (mode.kind === 'blocked') {
		return (
			<div className="grid gap-6 lg:grid-cols-2 lg:items-start">
				<CloudflareCard title="Cloudflare can't be connected yet">
					<span className="block">{ENCRYPTION_MESSAGE}</span>
					<span className="mt-3 block"><CopyField label="Command" value={ENCRYPTION_COMMAND} /></span>
					<span className="mt-3 block">
						<button type="button" className="text-sm text-brand-ink underline underline-offset-4" onClick={() => manualRef.current?.querySelector<HTMLElement>('input, button[role="combobox"]')?.focus()}>
							Or add your records yourself →
						</button>
					</span>
				</CloudflareCard>
				{manual}
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			{usable ? (
				<CloudflareCard title="Cloudflare is connected" large action={<Button size="lg" onClick={() => toWizard('domains')}>Choose domains</Button>}>
					{usable.implicit ? 'Ready Set Mail can use the Cloudflare token set on this server.' : `Connected to ${usable.cf_account_name ?? usable.label}.`} Choose the domains to set up.
				</CloudflareCard>
			) : (
				<CloudflareCard title="Connect Cloudflare" large action={<Button size="lg" onClick={() => toWizard('connect')}>Connect Cloudflare</Button>}>
					<span className="block">Ready Set Mail sets up the DNS records for you.</span>
					<ul className="mt-3 list-disc space-y-1 pl-5">
						{WILL_DO.map((t) => (
							<li key={t}>{t}</li>
						))}
					</ul>
				</CloudflareCard>
			)}
			{revealed ? (
				manual
			) : (
				<p>
					<button type="button" className="text-sm text-ink-2 underline underline-offset-4 hover:text-ink-1" onClick={() => setRevealed(true)}>
						I'll add DNS records myself
					</button>
				</p>
			)}
		</div>
	);
}

function CloudflareCard({ title, children, action, large }: { title: string; children: ReactNode; action?: ReactNode; large?: boolean }) {
	return (
		<Card role="region" aria-label={title}>
			<CardContent className={large ? 'space-y-5 sm:p-8' : 'space-y-4 sm:p-6'}>
				<h2 className={large ? 'text-2xl font-semibold tracking-tight' : 'text-xl font-semibold tracking-tight'}>{title}</h2>
				<div className={large ? 'max-w-prose text-base text-ink-2' : 'max-w-prose text-sm text-ink-2'}>{children}</div>
				{action ? <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end [&>button]:max-sm:w-full">{action}</div> : null}
			</CardContent>
		</Card>
	);
}
