import { Button } from '@ready-set-mail/ui';
import { Check } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice } from '../../../components/states';
import { WizardProgress } from '../../../components/wizard/WizardProgress';
import { ApiError } from '../../../lib/api';
import {
	CF_STEP_KEYS,
	activeConnection,
	consumeOAuthReturn,
	oauthErrorMessage,
	readProgress,
	useCfConnections,
	writeProgress,
	type CfConnection,
	type CfStepKey,
	type CfWizardProgress,
} from '../../../lib/cloudflare';
import { fetchPlan, markWizardState } from '../../../lib/dns-plan';
import { useHosted, useSession } from '../../../lib/session';
import { ConnectStep } from './ConnectStep';
import { DomainsStep } from './DomainsStep';
import { DoneStep } from './DoneStep';
import { PlanStep } from './PlanStep';
import { ZonesStep } from './ZonesStep';

const LABELS: Record<CfStepKey, string> = { connect: 'Connect', zones: 'Zones', domains: 'Domains', dmarc: 'DMARC', reports_mailbox: 'Reports mailbox', done: 'Done' };

/** `#/setup/cloudflare`: connect, choose zones, add domains, write DMARC and the reports mailbox, land on the overview. */
export function CloudflareWizardPage() {
	const { me } = useSession();
	const hosted = useHosted();
	const workspace = me?.workspace_id ?? null;
	const conns = useCfConnections();
	const [progress, setProgress] = useState<CfWizardProgress>(() => readProgress(workspace) ?? { step: 'connect', domainIds: [], written: { domains: 0, records: 0 } });
	const [returnError, setReturnError] = useState<string | null>(null);
	const returned = useRef(false);
	// The connection just made, until the connections list has caught up with it.
	// What the step just left wrote, said once in the header of the step after it.
	const [notice, setNotice] = useState<{ text: string; shownOn: CfStepKey } | null>(null);
	const [fresh, setFresh] = useState<CfConnection | null>(null);

	// Back from Cloudflare's consent screen: read the result once, then take it out of the address bar.
	useEffect(() => {
		if (returned.current) return;
		returned.current = true;
		const r = consumeOAuthReturn();
		if (r?.error) setReturnError(oauthErrorMessage(r.error));
		if (r?.connection) void conns.refetch();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => writeProgress(workspace, progress), [workspace, progress]);

	const go = useCallback((step: CfStepKey, extra: Partial<CfWizardProgress> = {}) => setProgress((p) => ({ ...p, ...extra, step })), []);

	const steps = CF_STEP_KEYS.filter((k) => !(hosted && k === 'reports_mailbox'));
	const connection: CfConnection | null = conns.data ? (conns.data.connections.find((c) => c.id === progress.connectionId && c.status === 'active') ?? activeConnection(conns.data) ?? (fresh?.id === progress.connectionId ? fresh : null)) : null;

	// An existing connection makes step 1 unnecessary; the server token has no zone list to choose from.
	useEffect(() => {
		if (progress.step !== 'connect' || !connection || returnError) return;
		go(connection.implicit || connection.zones.length > 0 ? 'domains' : 'zones', { connectionId: connection.id });
	}, [progress.step, connection, returnError, go]);

	const markAll = (ids: number[], patch: Parameters<typeof markWizardState>[1]) => void Promise.all(ids.map((id) => markWizardState(id, patch)));
	const afterDmarc = () => {
		markAll(progress.domainIds, { domain: 'complete', dmarc: 'complete' });
		go(hosted ? 'done' : 'reports_mailbox');
	};
	const afterMailbox = () => {
		markAll(progress.domainIds, { routing: 'complete' });
		go('done');
	};
	const addRecords = (from: CfStepKey, w: { ids: string[]; verified: number; rules: number }) => {
		const n = w.ids.length;
		setProgress((p) => ({ ...p, written: { ...p.written, records: p.written.records + n } }));
		const noun = w.rules > 0 ? (n === 1 ? 'change' : 'changes') : n === 1 ? 'record' : 'records';
		setNotice({ text: `${n} ${noun} written to Cloudflare${w.verified === n ? ' and checked' : ''}`, shownOn: from === 'dmarc' && !hosted ? 'reports_mailbox' : 'done' });
	};

	const index = Math.max(0, steps.indexOf(progress.step));
	let body;
	if (conns.isPending) body = <PageSkeleton label="Checking Cloudflare" />;
	else if (conns.isError) {
		const denied = conns.error instanceof ApiError && conns.error.status === 403;
		body = denied ? (
			<div className="space-y-4">
				<p className="text-sm text-ink-2">Only owners and admins can connect Cloudflare. Ask one of them, or add your DNS records yourself.</p>
				<Button asChild variant="secondary">
					<Link to="/setup">Back to setup</Link>
				</Button>
			</div>
		) : (
			<LoadError error={conns.error} onRetry={() => void conns.refetch()} title="Could not check Cloudflare" />
		);
	} else if (progress.step === 'connect' || (progress.step !== 'done' && !connection)) {
		body = <ConnectStep offer={conns.data} returnError={returnError} onConnected={(c) => { setFresh(c); setReturnError(null); go(c.implicit || c.zones.length > 0 ? 'domains' : 'zones', { connectionId: c.id }); }} />;
	} else if (progress.step === 'zones' && connection) {
		body = <ZonesStep connection={connection} taken={(conns.data?.connections ?? []).filter((c) => c.id !== connection.id).flatMap((c) => c.zones.map((z) => z.id))} onNext={() => go('domains')} />;
	} else if (progress.step === 'domains' && connection) {
		body = <DomainsStep connection={connection} onNext={(ids, added) => go('dmarc', { domainIds: ids, written: { domains: progress.written.domains + added, records: progress.written.records } })} />;
	} else if (progress.step === 'dmarc') {
		body = <PlanStep key="dmarc" stepKey="dmarc" domainIds={progress.domainIds} onNext={afterDmarc} onWritten={(w) => addRecords('dmarc', w)} />;
	} else if (progress.step === 'reports_mailbox') {
		body = <PlanStep key="mailbox" stepKey="reports_mailbox" domainIds={progress.domainIds} onNext={afterMailbox} onWritten={(w) => addRecords('reports_mailbox', w)} />;
	} else {
		body = <Done progress={progress} />;
	}

	return (
		<div className="space-y-6">
			<header className="space-y-3">
				<h1 className="text-2xl font-bold tracking-tight">Set up with Cloudflare</h1>
				<WizardProgress label="Cloudflare setup progress" current={index} steps={steps.map((k, i) => ({ label: LABELS[k], state: i < index ? 'complete' : 'pending' }))} />
			</header>
			<ReadOnlyNotice />
			{notice && notice.shownOn === progress.step ? (
				<p role="status" className="flex items-center gap-2 text-sm text-success">
					<Check aria-hidden className="size-4 shrink-0" />
					{notice.text}
				</p>
			) : null}
			{body}
		</div>
	);
}

function Done({ progress }: { progress: CfWizardProgress }) {
	const plan = useQuery({ queryKey: ['dns-plan-not-written', ...progress.domainIds], queryFn: () => fetchPlan(progress.domainIds), enabled: progress.domainIds.length > 0, retry: false });
	return <DoneStep domainIds={progress.domainIds} written={progress.written} notWritten={plan.data?.not_written ?? []} />;
}
