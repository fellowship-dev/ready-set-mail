import type { KeptRecord } from '../../lib/removal-notice';
import { Badge, Button, Card, CardContent, toast } from '@ready-set-mail/ui';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, useMtaSts, useSpfFlatten } from '../../lib/domain-queries';
import { useAddOns } from '../../lib/session';
import { SpfCard } from './SpfCard';
import type { MtaStsStatus } from '../../lib/types';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';
import { ConfirmDialog } from './ConfirmDialog';

interface ToolProps {
	domainId: number;
	title: string;
	badge: ReactNode;
	active: boolean;
	activeText: string;
	inactiveText: string;
	configureTo: string;
	disablePath: string;
	disableKey: readonly unknown[];
	disableTitle: string;
	disableDescription: string;
}

function ToolCard(p: ToolProps) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const disable = useMutation({
		mutationFn: () => api<{ kept?: KeptRecord[] } | undefined>(p.disablePath, { method: 'DELETE' }),
		onSuccess: async (res) => {
			const kept = res?.kept ?? [];
			// A record the customer changed is not deleted: say which, so it is not mistaken for a clean removal.
			toast({ title: `${p.title} disabled`, ...(kept.length ? { description: `Kept ${kept.length} DNS ${kept.length === 1 ? 'record' : 'records'} you changed: ${kept.map((k) => `${k.type} ${k.name} (${k.reason})`).join('; ')}.` } : {}), variant: kept.length ? 'warning' : 'success' });
			setOpen(false);
			await qc.invalidateQueries({ queryKey: p.disableKey });
		},
	});
	return (
		<Card>
			<CardContent className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-semibold">{p.title}</h3>
					{p.badge}
				</div>
				<p className="text-sm text-ink-2">{p.active ? p.activeText : p.inactiveText}</p>
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="secondary" size="sm">
						<Link to={p.configureTo}>Configure</Link>
					</Button>
					{p.active ? (
						<WriteButton variant="danger" size="sm" onClick={() => setOpen(true)}>
							Disable
						</WriteButton>
					) : null}
				</div>
			</CardContent>
			<ConfirmDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) disable.reset();
				}}
				title={p.disableTitle}
				description={p.disableDescription}
				confirmLabel="Disable"
				busyLabel="Disabling…"
				variant="danger"
				busy={disable.isPending}
				error={disable.isError ? errorMessage(disable.error) : null}
				onConfirm={() => disable.mutate()}
			/>
		</Card>
	);
}

const activeBadge = (
	<Badge variant="success">
		<CheckCircle2 aria-hidden />
		Active
	</Badge>
);
const availableBadge = (
	<Badge variant="outline">
		<CircleDashed aria-hidden />
		Available
	</Badge>
);

function mtaCard(id: number, s: MtaStsStatus) {
	const active = !!s.config?.enabled;
	const mode = s.config?.mode ?? 'testing';
	return (
		<ToolCard
			domainId={id}
			title="MTA-STS"
			badge={
				active ? (
					<Badge variant={mode === 'enforce' ? 'success' : 'brand'}>
						<ShieldCheck aria-hidden />
						{mode}
					</Badge>
				) : (
					availableBadge
				)
			}
			active={active}
			activeText={`Requiring TLS for inbound mail (${mode} mode).`}
			inactiveText="Require TLS and collect failure reports for inbound mail."
			configureTo={`/domains/${id}/mta-sts`}
			disablePath={`/api/domains/${id}/mta-sts`}
			disableKey={domainKeys.mta(id)}
			disableTitle="Disable MTA-STS?"
			disableDescription="Senders stop being told to require TLS for your inbound mail, and the policy records are removed."
		/>
	);
}

function Slot<T>({ q, title, show, render }: { q: UseQueryResult<T>; title: string; show: (d: T) => boolean; render: (d: T) => ReactNode }) {
	if (q.isPending) return <ListSkeleton rows={1} label={`Loading ${title}`} />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title={`Could not load ${title}`} />;
	return show(q.data) ? <>{render(q.data)}</> : null;
}

/** SPF flattening and MTA-STS: only shown when a tool is available or configured for this instance. */
export function DnsTools({ domainId }: { domainId: number }) {
	// SPF flattening is an add-on: where the workspace does not have it, nothing is asked and nothing is shown (src/hosted/plan-limits.ts capability).
	const spfOn = useAddOns().spf_flattening;
	const spf = useSpfFlatten(domainId, spfOn);
	const mta = useMtaSts(domainId);
	const spfHidden = !spfOn || (spf.isSuccess && !spf.data.available && !spf.data.config);
	const mtaHidden = mta.isSuccess && !mta.data.available && !mta.data.config;
	if (spfHidden && mtaHidden) return null;
	return (
		<Section title="DNS tools" description="Optional tools that change your DNS for you.">
			<div className="grid gap-3 md:grid-cols-2">
				{spfOn ? <Slot q={spf} title="SPF flattening" show={(d) => d.available || !!d.config} render={(d) => <SpfCard domainId={domainId} status={d} />} /> : null}
				<Slot q={mta} title="MTA-STS" show={(d) => d.available || !!d.config} render={(d) => mtaCard(domainId, d)} />
			</div>
		</Section>
	);
}
