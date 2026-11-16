import { Button, Checkbox, FieldError, Skeleton } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { LoadError, WriteButton } from '../../../components/states';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { ApiError, errorMessage } from '../../../lib/api';
import { cfKeys, fetchZones, importAll, importSummary, type CfConnection, type ImportedNote, type ImportResult } from '../../../lib/cloudflare';
import { zoneCovering, zonesNotAdded } from '../../../lib/first-run';
import { keys } from '../../../lib/queries';

type Selection = NonNullable<ImportResult['needs_selection']>;

/**
 * Hosted, right after connecting: every active zone the connection can see becomes a verified domain, with nothing written to DNS.
 * Only when they would not all fit the plan does the person choose which to add. `onDone` leaves for the dashboard.
 *
 * `agency` ("My clients'"): the account holds many clients, so only the zone of each client domain being set up (`agency.targets`, the
 * workspace's pending claims) is added; the other zones are listed ("Also in this Cloudflare account") and nothing is imported for them.
 * With no target at all nothing is added, and Add domain offers the account's zones one at a time.
 */
export function ImportStep({ connection, onDone, agency }: { connection: CfConnection; onDone: (note?: ImportedNote) => void; agency?: { targets: string[] } }) {
	const qc = useQueryClient();
	const started = useRef(false);
	const [state, setState] = useState<{ kind: 'running' } | { kind: 'choose'; selection: Selection } | { kind: 'empty' } | { kind: 'missing'; domains: string[]; others: string[] } | { kind: 'error'; error: unknown }>({ kind: 'running' });

	async function run(zoneIds?: string[]) {
		setState({ kind: 'running' });
		try {
			if (agency && !zoneIds) {
				if (agency.targets.length === 0) return onDone({ text: "Connected to Cloudflare. Nothing was added: add each client's domain with Add domain, which offers this account's zones.", ok: false });
				const zones = await fetchZones(connection);
				const ids = [...new Set(agency.targets.flatMap((t) => { const z = zoneCovering(t, zones); return z ? [z.id] : []; }))];
				if (ids.length === 0) return setState({ kind: 'missing', domains: agency.targets, others: zonesNotAdded(zones, []).map((z) => z.name) });
				zoneIds = ids;
			}
			const { totals, selection } = await importAll(connection.id, zoneIds);
			void qc.invalidateQueries({ queryKey: keys.domains });
			void qc.invalidateQueries({ queryKey: ['auth-status'] });
			void qc.invalidateQueries({ queryKey: cfKeys.connections });
			void qc.invalidateQueries({ queryKey: cfKeys.suggestions });
			if (selection) return setState({ kind: 'choose', selection });
			if (totals.imported.length + totals.verifiedClaims.length + totals.already === 0 && totals.skipped.length === 0) return setState({ kind: 'empty' });
			// Said on the dashboard, in the page itself: a toast floats over whatever the person needs to read next.
			onDone({ text: importSummary(totals), ok: totals.imported.length + totals.verifiedClaims.length + totals.already > 0 });
		} catch (e) {
			setState({ kind: 'error', error: e });
		}
	}

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		void run();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (state.kind === 'running') {
		return (
			<StepCard title="Adding your domains">
				<div className="space-y-3">
					<p className="text-sm text-ink-2">Reading the zones in your Cloudflare account and confirming you control them. Nothing in your DNS is changed.</p>
					<Skeleton className="h-16 w-full" role="status" aria-label="Adding your Cloudflare domains" />
				</div>
			</StepCard>
		);
	}
	if (state.kind === 'error') return <LoadError error={state.error} onRetry={() => void run()} title="Could not add your Cloudflare domains" />;
	if (state.kind === 'missing') {
		return (
			<StepCard title={`${state.domains.join(', ')} isn't in this Cloudflare account`}>
				<div className="space-y-4">
					<p className="max-w-prose text-sm text-ink-2">Nothing was added. Connect the account that holds {state.domains.length === 1 ? 'it' : 'them'}, or add the records yourself.</p>
					{state.others.length > 0 ? (
						<p className="max-w-prose text-sm text-ink-2" data-testid="also-in-account">
							Also in this Cloudflare account: {state.others.join(', ')}.
						</p>
					) : null}
					<StepFooter
						end={
							<Button asChild>
								<Link to="/setup">Back to your domain</Link>
							</Button>
						}
					/>
				</div>
			</StepCard>
		);
	}
	if (state.kind === 'empty') {
		return (
			<StepCard title="No domains found">
				<div className="space-y-4">
					<p className="max-w-prose text-sm text-ink-2">This Cloudflare account has no active zones. Once a domain is active on Cloudflare it can be added here.</p>
					<StepFooter end={<Button onClick={() => onDone()}>Go to dashboard</Button>} />
				</div>
			</StepCard>
		);
	}
	return <Choose selection={state.selection} onChoose={(ids) => void run(ids)} onDismiss={() => onDone()} />;
}

/** The plan covers fewer domains than the account has zones: the person picks which to add. */
export function Choose({ selection, onChoose, onDismiss, busy = false, error }: { selection: Selection; onChoose: (zoneIds: string[]) => void; onDismiss: () => void; busy?: boolean; error?: unknown }) {
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const over = picked.size > selection.room;
	const toggle = (id: string, on: boolean) => {
		const next = new Set(picked);
		if (on) next.add(id);
		else next.delete(id);
		setPicked(next);
	};
	if (selection.room === 0) {
		return (
			<StepCard title="Your plan is full">
				<div className="space-y-4">
					<p className="max-w-prose text-sm text-ink-2">
						Your plan covers {selection.cap} {selection.cap === 1 ? 'domain' : 'domains'} and this workspace has {selection.cap === 1 ? 'it' : 'them all'}. Remove a domain you no longer need to add another from Cloudflare.
					</p>
					<StepFooter end={<Button onClick={onDismiss}>Go to dashboard</Button>} />
				</div>
			</StepCard>
		);
	}
	return (
		<StepCard title="Choose which to add">
			<div className="space-y-4">
				<p className="max-w-prose text-sm text-ink-2">
					Your plan covers {selection.cap} {selection.cap === 1 ? 'domain' : 'domains'}. Choose which to add{selection.room < selection.cap ? ` (${selection.room} left)` : ''}.
				</p>
				<ul className="divide-y divide-line rounded-lg border border-line" aria-label="Zones in your Cloudflare account">
					{selection.zones.map((z) => (
						<li key={z.id}>
							<label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
								<Checkbox checked={picked.has(z.id)} onCheckedChange={(c) => toggle(z.id, c === true)} />
								<span className="min-w-0 font-medium [overflow-wrap:anywhere]">{z.name}</span>
							</label>
						</li>
					))}
				</ul>
				<p className={over ? 'text-sm text-danger' : 'text-sm text-ink-2'} aria-live="polite">
					{picked.size} of {selection.room} chosen
				</p>
				{error ? <FieldError>{error instanceof ApiError ? errorMessage(error) : 'Could not add them. Try again.'}</FieldError> : null}
				<StepFooter
					end={
						<WriteButton loading={busy} disabled={picked.size === 0 || over} onClick={() => onChoose([...picked])}>
							{picked.size === 0 ? 'Add domains' : `Add ${picked.size} ${picked.size === 1 ? 'domain' : 'domains'}`}
						</WriteButton>
					}
				/>
			</div>
		</StepCard>
	);
}
