import { Button, Card, CardContent, Skeleton } from '@ready-set-mail/ui';
import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CopyField } from '../../../components/domain/CopyField';
import { ENCRYPTION_COMMAND, ENCRYPTION_MESSAGE, clearProgress, usableConnection, useCfConnections, writeProgress } from '../../../lib/cloudflare';
import { useDomainClaims } from '../../../lib/queries';
import { useHosted, useSession } from '../../../lib/session';
import { DomainStep } from '../setup/DomainStep';

/**
 * The first screen of `#/setup` (no domain yet). Two ways in: let Cloudflare write the records, or type a domain and
 * copy them by hand. Anything that cannot offer Cloudflare shows today's domain form alone.
 */
export function FirstScreen({ onDomainSet }: { onDomainSet: (domainId: number) => void }) {
	const hosted = useHosted();
	const { canWrite, me } = useSession();
	const navigate = useNavigate();
	const manualRef = useRef<HTMLDivElement>(null);
	const claims = useDomainClaims();
	// Members cannot connect anything; skip the request instead of waiting for its 403.
	const conns = useCfConnections(canWrite);
	const manual = (secondary: boolean) => (
		<div ref={manualRef}>
			<DomainStep onDomainSet={onDomainSet} secondary={secondary} title="I'll add DNS records myself" hideConnectLink />
		</div>
	);
	const plain = <DomainStep onDomainSet={onDomainSet} />;

	if (!canWrite) return plain;
	if (conns.isPending) return <Skeleton className="h-40 w-full" role="status" aria-label="Checking Cloudflare" />;
	// Failing request, or hosted waiting for a DNS proof: exactly the form there always was.
	if (conns.isError || !conns.data) return plain;
	if (hosted && (claims.data ?? []).some((c) => c.status === 'pending')) return plain;

	const data = conns.data;
	// Hosted: a customer cannot set the encryption key, so without it there is no Cloudflare path to offer.
	if (hosted && !data.encryption_configured) return plain;
	const usable = usableConnection(data);
	const workspace = me?.workspace_id ?? null;
	const toWizard = (step: 'connect' | 'domains') => {
		clearProgress(workspace);
		writeProgress(workspace, { step, domainIds: [], written: { domains: 0, records: 0 }, connectionId: usable?.id });
		navigate('/setup/cloudflare');
	};

	let card: ReactNode;
	let manualSecondary = true;
	if (usable) {
		card = (
			<CloudflareCard title="Cloudflare is connected" action={<Button onClick={() => toWizard('domains')}>Choose domains</Button>}>
				{usable.implicit ? 'Ready Set Mail can use the Cloudflare token set on this server.' : `Connected to ${usable.cf_account_name ?? usable.label}.`} Choose the domains to set up.
			</CloudflareCard>
		);
	} else if (!data.oauth.available && !data.token_paste) {
		// Hosted without Cloudflare support: no chooser at all.
		if (hosted || data.encryption_configured) return plain;
		manualSecondary = false;
		card = (
			<CloudflareCard title="Cloudflare can't be connected yet">
				<span className="block">{ENCRYPTION_MESSAGE}</span>
				<span className="mt-3 block"><CopyField label="Command" value={ENCRYPTION_COMMAND} /></span>
				<span className="mt-3 block">
					<button type="button" className="text-sm text-brand-ink underline underline-offset-4" onClick={() => manualRef.current?.querySelector<HTMLElement>('input, button[role="combobox"]')?.focus()}>
						Or add your records yourself →
					</button>
				</span>
			</CloudflareCard>
		);
	} else {
		card = (
			<CloudflareCard title="Connect Cloudflare" action={<Button onClick={() => toWizard('connect')}>Connect Cloudflare</Button>}>
				Ready Set Mail writes the DNS records for you. You see every record before anything is written.
			</CloudflareCard>
		);
	}

	return (
		<div className="grid gap-6 lg:grid-cols-2 lg:items-start">
			{card}
			{manual(manualSecondary)}
		</div>
	);
}

function CloudflareCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
	return (
		<Card role="region" aria-label={title}>
			<CardContent className="space-y-4 sm:p-6">
				<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
				<div className="max-w-prose text-sm text-ink-2">{children}</div>
				{action ? <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">{action}</div> : null}
			</CardContent>
		</Card>
	);
}
