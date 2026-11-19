import type { KeptRecord } from '../../lib/removal-notice';
import { Badge, Button, Card, CardContent, toast, type BadgeProps } from '@ready-set-mail/ui';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Clock, Info, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useDnsToolsOff } from '../../lib/hosted';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, useMtaSts, useSpfFlatten } from '../../lib/domain-queries';
import { useAddOns } from '../../lib/session';
import { SpfCard } from './SpfCard';
import { cardState, type CardState } from '../../lib/mta-sts';
import type { MtaStsStatus, SpfFlatStatus } from '../../lib/types';
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

const CARD_BADGE: Record<CardState, { variant: BadgeProps['variant']; Icon: typeof CheckCircle2 }> = {
	off: { variant: 'outline', Icon: CircleDashed },
	setting_up: { variant: 'info', Icon: Clock },
	testing: { variant: 'success', Icon: ShieldCheck },
	enforced: { variant: 'success', Icon: ShieldCheck },
	unavailable: { variant: 'outline', Icon: Info },
};
const CARD_LINK: Record<CardState, string> = { off: 'Set up', setting_up: 'Continue setup', testing: 'Open', enforced: 'Open', unavailable: 'See why' };

/** MTA-STS: the real state in one word, and one link to the page where everything about it happens (turning it off included). */
function MtaStsCard({ id, s }: { id: number; s: MtaStsStatus }) {
	const { state, word, detail } = cardState(s);
	const { variant, Icon } = CARD_BADGE[state];
	return (
		<Card>
			<CardContent className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-semibold">MTA-STS</h3>
					<Badge variant={variant}>
						<Icon aria-hidden />
						{word}
					</Badge>
				</div>
				<p className="text-sm text-ink-2">{detail}</p>
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="secondary" size="sm">
						<Link to={`/domains/${id}/mta-sts`}>{CARD_LINK[state]}</Link>
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function Slot<T>({ q, title, show, render }: { q: UseQueryResult<T>; title: string; show: (d: T) => boolean; render: (d: T) => ReactNode }) {
	if (q.isPending) return <ListSkeleton rows={1} label={`Loading ${title}`} />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title={`Could not load ${title}`} />;
	return show(q.data) ? <>{render(q.data)}</> : null;
}

/** SPF flattening (only where it can work) and MTA-STS (always, with its real state, so "not available" says why). */
/** The tools the section lists, named for what is there: SPF flattening only where it is offered or set up, MTA-STS always (its card says its own state). */
const dnsToolsSummary = (spfListed: boolean) => (spfListed ? 'Optional tools for your DNS: SPF flattening and MTA-STS.' : 'Optional tool for your DNS: MTA-STS.');
const spfListed = (q: UseQueryResult<SpfFlatStatus>) => q.isSuccess && (q.data.available || !!q.data.config);

export function DnsTools({ domainId }: { domainId: number }) {
	// Hosted: SPF flattening is an add-on, shown only where the workspace has it (src/hosted/plan-limits.ts capability); a hosted-records domain's SPF is flattened by the hosted service. MTA-STS is shown everywhere with its real
	// state: the server says whether it can be turned on here (the capability check) and, when it cannot, why.
	const { spfOff } = useDnsToolsOff(domainId);
	const spf = useSpfFlatten(domainId, !spfOff);
	const mta = useMtaSts(domainId);
	return (
		<Section title="DNS tools" description={dnsToolsSummary(spfListed(spf))}>
			<div className="grid gap-3 md:grid-cols-2">
				{spfOff ? null : <Slot q={spf} title="SPF flattening" show={(d) => d.available || !!d.config} render={(d) => <SpfCard domainId={domainId} status={d} />} />}
				<Slot q={mta} title="MTA-STS" show={() => true} render={(d) => <MtaStsCard id={domainId} s={d} />} />
			</div>
		</Section>
	);
}
