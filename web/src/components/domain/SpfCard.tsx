import { Alert, Badge, Button, Card, CardContent, toast, type BadgeProps } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { connectCloudflarePath } from '../../lib/cloudflare';
import { domainKeys } from '../../lib/domain-queries';
import { formatDate } from '../../lib/format';
import { ACTION_LABEL, CHECK_AGAIN_NOW, NOT_ALLOWED_ON_SENTENCE, offSentence, onSentence, pendingSentence, PENDING_WHY, spfState, staleSentence, stoppedSentence, SPF_LOOKUP_ALLOWED, type SpfAction } from '../../lib/spf-flatten';
import type { SpfFlatStatus } from '../../lib/types';
import { TxtRecord } from '../wizard/RecordPair';
import { WriteButton } from '../states';
import { ConfirmDialog } from './ConfirmDialog';
import { spfLookupJudgement } from '@ready-set-mail/dns-checks/spf-record';

/** Words for the toast after turning off: what happened to the record, plainly. */
function turnedOffToast(res: { restored?: boolean; why?: 'edited_outside' | 'record_missing' } | undefined) {
	if (!res || res.restored !== false) return toast({ title: 'SPF flattening turned off', description: 'Your original SPF record is back in Cloudflare.', variant: 'success' });
	return toast({
		title: 'SPF flattening turned off',
		description: res.why === 'record_missing' ? 'There was no SPF record in Cloudflare, so nothing was put back.' : 'The record in Cloudflare was changed outside Ready Set Mail, so we left it as it is.',
		variant: 'warning',
	});
}

function lookupBadge(count: number): { variant: BadgeProps['variant']; word: string; Icon: typeof CheckCircle2 } {
	const j = spfLookupJudgement(count);
	if (j.level === 'over') return { variant: 'danger', word: j.label.toLowerCase(), Icon: AlertTriangle };
	if (j.level !== 'ok') return { variant: 'warning', word: j.label.toLowerCase(), Icon: AlertTriangle };
	return { variant: 'success', word: j.label.toLowerCase(), Icon: CheckCircle2 };
}

/** The SPF flattening card of the domain page: what it is doing, when it last looked, and the one thing to do when it cannot keep the record current. */
export function SpfCard({ domainId, status }: { domainId: number; status: SpfFlatStatus }) {
	const qc = useQueryClient();
	const { pathname, search } = useLocation();
	const [confirm, setConfirm] = useState(false);
	const [waitAnswer, setWaitAnswer] = useState<string | null>(null);
	const state = spfState(status);
	const allowed = status.access?.allowed !== false;
	const count = status.lookup_count ?? null;
	const page = `/domains/${domainId}/spf-flatten`;
	const refreshAll = async () => {
		await qc.invalidateQueries({ queryKey: domainKeys.spf(domainId) });
		await qc.invalidateQueries({ queryKey: ['domains'] });
	};

	const checkNow = useMutation({
		mutationFn: () => api<{ outcome: 'changed' | 'unchanged' | 'pending' | 'problem'; message?: string }>(`/api/domains/${domainId}/spf-flatten/refresh`, { method: 'POST' }),
		onSuccess: async (r) => {
			setWaitAnswer(r.outcome === 'pending' ? (r.message ?? null) : null);
			if (r.outcome === 'pending') toast({ title: 'Still waiting to confirm', description: r.message, variant: 'info' });
			else if (r.outcome === 'changed') toast({ title: 'Your record was updated', description: 'Your providers changed their addresses.', variant: 'success' });
			else if (r.outcome === 'unchanged') toast({ title: 'Checked', description: 'Nothing changed.', variant: 'success' });
			await refreshAll();
		},
	});
	const turnOff = useMutation({
		mutationFn: () => api<{ restored?: boolean; why?: 'edited_outside' | 'record_missing' } | undefined>(`/api/domains/${domainId}/spf-flatten`, { method: 'DELETE' }),
		onSuccess: async (res) => {
			turnedOffToast(res);
			setConfirm(false);
			await refreshAll();
		},
		onError: () => void refreshAll(),
	});

	let badge: ReactNode = (
		<Badge variant="outline">
			<CircleDashed aria-hidden />
			Available
		</Badge>
	);
	let text: ReactNode;
	let extra: ReactNode = null;
	let action: { kind: SpfAction; label: string } | null = null;
	let details = false;

	if (state.kind === 'off') {
		if (count !== null) {
			const { variant, word, Icon } = lookupBadge(count);
			badge = (
				<Badge variant={variant}>
					<Icon aria-hidden />
					{count}/{SPF_LOOKUP_ALLOWED} lookups ({word})
				</Badge>
			);
		}
		text = offSentence(count);
	} else if (state.kind === 'on') {
		badge = (
			<Badge variant="success">
				<CheckCircle2 aria-hidden />
				On
			</Badge>
		);
		text = allowed ? onSentence(state.config) : NOT_ALLOWED_ON_SENTENCE;
		details = true;
		if (allowed && state.stale) extra = <p className="text-sm text-ink-2">{staleSentence(state.config)}</p>;
		if (allowed && state.config.pending) {
			extra = (
				<>
					{extra}
					<Alert variant="info" data-testid="spf-pending">
						<p>{pendingSentence(state.config.pending)}</p>
						<p className="mt-1">{PENDING_WHY}</p>
						{waitAnswer ? <p className="mt-1 font-medium" role="status">{waitAnswer}</p> : null}
					</Alert>
				</>
			);
			action = { kind: 'try_again', label: CHECK_AGAIN_NOW };
		}
		if (!allowed) action = { kind: 'turn_off', label: ACTION_LABEL.turn_off };
		if (state.config.previous_record !== null && state.config.flattened_record) {
			extra = (
				<>
					{extra}
					<details className="text-sm">
						<summary className="cursor-pointer text-ink-1">What changed{state.config.last_changed_at ? ` on ${formatDate(state.config.last_changed_at)}` : ''}</summary>
						<div className="mt-2 space-y-3">
							<TxtRecord title="Before" value={state.config.previous_record} copyable={false} />
							<TxtRecord title="Now" value={state.config.flattened_record} copyable={false} />
						</div>
					</details>
				</>
			);
		}
	} else if (state.kind === 'problem') {
		badge = (
			<Badge variant="warning">
				<AlertTriangle aria-hidden />
				Needs attention
			</Badge>
		);
		text = state.problem.message ?? 'We could not keep your record current.';
		action = { kind: state.action, label: ACTION_LABEL[state.action] };
		details = true;
	} else if (state.kind === 'stopped') {
		badge = (
			<Badge variant="warning">
				<AlertTriangle aria-hidden />
				Stopped
			</Badge>
		);
		text = stoppedSentence(state.reason);
		details = true;
		extra = (
			<div className="space-y-3">
				{state.config.flattened_record ? <TxtRecord title="In Cloudflare now (as of the last check)" value={state.config.flattened_record} copyable={false} /> : null}
				<TxtRecord title="Your original record" value={state.config.original_record} />
			</div>
		);
		action = { kind: state.reason === 'connection_gone' ? 'reconnect' : 'prove', label: ACTION_LABEL[state.reason === 'connection_gone' ? 'reconnect' : 'prove'] };
	} else {
		badge = (
			<Badge variant="warning">
				<AlertTriangle aria-hidden />
				Needs attention
			</Badge>
		);
		text = `${state.message} It is below: copy it into Cloudflare, or try again.`;
		extra = <TxtRecord title="Your original record" value={state.config.original_record} />;
		action = { kind: 'retry_restore', label: ACTION_LABEL.retry_restore };
	}

	const actionButton = action ? (
		action.kind === 'reconnect' ? (
			<Button asChild size="sm">
				<Link to={connectCloudflarePath(pathname, search)}>{action.label}</Link>
			</Button>
		) : action.kind === 'prove' ? (
			<Button asChild size="sm">
				<Link to={`/domains/${domainId}`}>{action.label}</Link>
			</Button>
		) : action.kind === 'review' ? (
			<Button asChild size="sm">
				<Link to={`${page}?review=1`}>{action.label}</Link>
			</Button>
		) : action.kind === 'turn_off' ? (
			<WriteButton size="sm" onClick={() => setConfirm(true)}>
				{action.label}
			</WriteButton>
		) : action.kind === 'retry_restore' ? (
			<WriteButton size="sm" loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
				{turnOff.isPending ? 'Trying…' : action.label}
			</WriteButton>
		) : (
			<WriteButton size="sm" loading={checkNow.isPending} onClick={() => checkNow.mutate()}>
				{checkNow.isPending ? 'Checking…' : action.label}
			</WriteButton>
		)
	) : null;

	return (
		<Card>
			<CardContent className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-semibold">SPF flattening</h3>
					{badge}
				</div>
				<p className="text-sm text-ink-2">{text}</p>
				{extra}
				{checkNow.isError ? <p role="alert" className="text-sm text-danger">{errorMessage(checkNow.error)}</p> : null}
				{turnOff.isError && !confirm ? <p role="alert" className="text-sm text-danger">{errorMessage(turnOff.error)}</p> : null}
				<div className="flex flex-wrap items-center gap-2">
					{actionButton}
					{state.kind === 'off' ? (
						<Button asChild variant="secondary" size="sm">
							<Link to={page}>{count !== null && count <= SPF_LOOKUP_ALLOWED ? 'See how it works' : 'Open SPF flattening'}</Link>
						</Button>
					) : null}
					{state.kind === 'on' && allowed ? (
						<WriteButton variant="danger" size="sm" onClick={() => setConfirm(true)}>
							Turn off
						</WriteButton>
					) : null}
					{state.kind === 'stopped' ? (
						<WriteButton variant="secondary" size="sm" loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
							{turnOff.isPending ? 'Trying…' : 'Try to put it back'}
						</WriteButton>
					) : null}
					{details ? (
						<Link to={page} className="text-sm text-brand-ink underline underline-offset-4">
							Details
						</Link>
					) : null}
				</div>
			</CardContent>
			<ConfirmDialog
				open={confirm}
				onOpenChange={(o) => {
					setConfirm(o);
					if (!o) turnOff.reset();
				}}
				title="Turn off SPF flattening?"
				description="Your original SPF record goes back in Cloudflare and Ready Set Mail stops checking your providers. It may need more than 10 lookups again."
				confirmLabel="Turn off"
				busyLabel="Turning off…"
				variant="danger"
				busy={turnOff.isPending}
				error={turnOff.isError ? errorMessage(turnOff.error) : null}
				onConfirm={() => turnOff.mutate()}
			/>
		</Card>
	);
}
