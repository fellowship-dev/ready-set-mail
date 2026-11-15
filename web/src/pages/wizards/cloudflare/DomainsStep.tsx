import { Alert, Badge, Button, Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { LoadError, WriteButton } from '../../../components/states';
import { PlanLimitNotice, planLimitOf, type PlanLimit } from '../../../components/PlanLimitNotice';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { api, errorMessage } from '../../../lib/api';
import { linkDomain, useCfZones, useDnsState, type CfConnection, type DnsState } from '../../../lib/cloudflare';
import { keys, useDomains } from '../../../lib/queries';
import { useHosted, useSession } from '../../../lib/session';
import { PRETICK_LIMIT } from './ZonesStep';

const MAX_NAMES = 50;

interface RowState {
	id?: number;
	linked?: boolean;
	error?: string;
	/** Not added because the plan is full. */
	blocked?: boolean;
	busy?: boolean;
}

const dmarcWords = (s: DnsState): string => {
	switch (s.dmarc.state) {
		case 'found': return s.dmarc.policy ? `DMARC p=${s.dmarc.policy}` : 'DMARC found';
		case 'inherited': return s.dmarc.policy ? `DMARC inherited p=${s.dmarc.policy}` : 'DMARC inherited';
		case 'missing': return 'DMARC missing';
		default: return "DMARC couldn't check";
	}
};
const spfWords = (s: DnsState): string => (s.spf === 'found' ? 'SPF found' : s.spf === 'missing' ? 'SPF missing' : "SPF couldn't check");

/** Step 3: choose the domains, add them, link each to the connection. Nothing is written to DNS here. */
export function DomainsStep({ connection, onNext }: { connection: CfConnection; onNext: (domainIds: number[], added: number) => void }) {
	const hosted = useHosted();
	const { status } = useSession();
	const qc = useQueryClient();
	const reportsId = useId();
	const zones = useCfZones(connection);
	const existing = useDomains();
	const [picked, setPicked] = useState<Set<string> | null>(null);
	const [reportsOn, setReportsOn] = useState<string | null>(null);
	const [rows, setRows] = useState<Record<string, RowState>>({});
	const [limit, setLimit] = useState<PlanLimit | null>(null);
	const [running, setRunning] = useState(false);

	const names = (zones.data ?? []).filter((z) => z.allowed).map((z) => z.name).sort();
	const shown = names.slice(0, MAX_NAMES);
	const dns = useDnsState(shown);

	if (zones.isPending || existing.isPending) return <StepCard title="Choose domains"><Skeleton className="h-32 w-full" role="status" aria-label="Loading your domains" /></StepCard>;
	if (zones.isError) return <LoadError error={zones.error} onRetry={() => void zones.refetch()} title="Could not list your Cloudflare zones" />;
	if (existing.isError) return <LoadError error={existing.error} onRetry={() => void existing.refetch()} title="Could not load your domains" />;

	const have = new Map(existing.data.map((d) => [d.domain, d.id]));
	const added = (n: string) => have.has(n) || rows[n]?.id !== undefined;
	const idOf = (n: string) => rows[n]?.id ?? have.get(n);
	const fresh = shown.filter((n) => !have.has(n));
	const selected = picked ?? new Set(fresh.length <= PRETICK_LIMIT ? fresh : []);
	const chosen = shown.filter((n) => have.has(n) || selected.has(n));
	const needsBase = !hosted && !status?.base_domain && !existing.data.some((d) => d.is_default === 1);
	const newOnes = (n: string) => !added(n);
	const reportsHome = needsBase ? ((reportsOn && chosen.includes(reportsOn) && newOnes(reportsOn)) ? reportsOn : chosen.find(newOnes) ?? null) : null;

	const patch = (n: string, p: RowState) => setRows((r) => ({ ...r, [n]: { ...r[n], ...p } }));
	const refresh = () => {
		void qc.invalidateQueries({ queryKey: keys.domains });
		void qc.invalidateQueries({ queryKey: ['auth-status'] });
	};

	/** Adds (when needed) and links one domain. `ok` is false when it failed or the plan is full. */
	async function work(n: string, asBase: boolean): Promise<{ ok: boolean; id?: number; created?: boolean }> {
		patch(n, { busy: true, error: undefined });
		try {
			let id = idOf(n);
			let created = false;
			if (id === undefined) {
				if (asBase) {
					const r = await api<{ domain_id?: number; pending?: boolean }>('/api/settings/base-domain', { method: 'POST', body: { domain: n } });
					id = r.domain_id;
				} else {
					const r = await api<{ domain?: { id: number }; pending?: boolean }>('/api/domains', { method: 'POST', body: { domain: n } });
					id = r.domain?.id;
				}
				if (id === undefined) {
					patch(n, { busy: false, error: 'Ownership of this domain is not proven yet. Add it from its own setup page.' });
					return { ok: false };
				}
				created = true;
				patch(n, { id });
				refresh();
			}
			if (!connection.implicit && !rows[n]?.linked) {
				await linkDomain(id, connection.id);
			}
			patch(n, { busy: false, linked: true });
			return { ok: true, id, created };
		} catch (e) {
			const l = planLimitOf(e);
			if (l) {
				setLimit(l);
				patch(n, { busy: false, blocked: true });
			} else patch(n, { busy: false, error: errorMessage(e) });
			return { ok: false };
		}
	}

	async function run(only?: string): Promise<{ failed: Set<string>; ids: number[]; created: number }> {
		const failedNames = new Set<string>();
		const ids: number[] = [];
		let created = 0;
		setRunning(true);
		setLimit(null);
		let stop = false;
		const todo = (only ? [only] : chosen).filter((n) => !rows[n]?.blocked || only);
		// The reports home goes first: everything else hangs off it.
		const ordered = reportsHome && todo.includes(reportsHome) ? [reportsHome, ...todo.filter((n) => n !== reportsHome)] : todo;
		for (const n of ordered) {
			if (stop) break;
			if (rows[n]?.linked && added(n)) {
				ids.push(idOf(n)!);
				continue;
			}
			const r = await work(n, n === reportsHome);
			if (r.ok && r.id !== undefined) {
				ids.push(r.id);
				if (r.created) created += 1;
			} else failedNames.add(n);
			if (!r.ok && n === reportsHome) stop = true;
		}
		refresh();
		setRunning(false);
		return { failed: failedNames, ids, created };
	}

	const done = (n: string) => added(n) && (connection.implicit || !!rows[n]?.linked);
	const live = chosen.filter((n) => !rows[n]?.blocked);
	const pendingNew = live.filter(newOnes);
	const addedCount = () => Object.values(rows).filter((r) => r.id !== undefined).length;
	const idsOf = (names: string[]) => names.map(idOf).filter((i): i is number => i !== undefined);
	const doneNames = live.filter(done);
	const failed = Object.values(rows).some((r) => r.error);

	/** One click: add and link everything chosen, then move on by itself when every one succeeded. */
	const runAndAdvance = () =>
		void run().then((r) => {
			if (r.failed.size === 0) onNext(r.ids, addedCount() + r.created);
		});
	const retryOne = (n: string) =>
		void run(n).then((r) => {
			if (r.failed.size === 0 && pendingNew.every((x) => x === n)) onNext([...new Set([...idsOf(doneNames), ...r.ids])], addedCount() + r.created);
		});
	const continueWithout = () => onNext(idsOf(doneNames), addedCount());

	let primary: { label: string; onClick: () => void; disabled?: boolean };
	if (pendingNew.length > 0) primary = { label: `Add ${pendingNew.length} ${pendingNew.length === 1 ? 'domain' : 'domains'}`, onClick: runAndAdvance };
	else primary = { label: 'Next', onClick: runAndAdvance, disabled: live.length === 0 };

	return (
		<StepCard title="Choose domains">
			<div className="space-y-4">
				<p className="max-w-prose text-sm text-ink-2">
					{connection.implicit ? 'All zones the server token can reach. ' : ''}Tick the domains to set up. Adding a domain writes nothing to DNS; you review every record on the next screens.
				</p>
				{names.length > MAX_NAMES ? <p className="text-sm text-ink-2">Showing the first {MAX_NAMES} of {names.length} zones.</p> : null}
				{shown.length === 0 ? <p className="text-sm text-ink-2">No zones are allowed yet. Go back and choose at least one.</p> : null}
				<ul className="divide-y divide-line rounded-lg border border-line">
					{shown.map((n) => {
						const st = dns.data?.find((s) => s.name === n);
						const row = rows[n];
						const isAdded = have.has(n);
						return (
							<li key={n} className="space-y-1 px-4 py-3">
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
										<Checkbox
											checked={isAdded || selected.has(n)}
											disabled={isAdded || running || added(n)}
											onCheckedChange={(c) => {
												const next = new Set(selected);
												if (c === true) next.add(n);
												else next.delete(n);
												setPicked(next);
											}}
										/>
										<span className="font-medium [overflow-wrap:anywhere]">{n}</span>
									</label>
									{isAdded ? <Badge variant="success">Already added</Badge> : row?.id !== undefined && done(n) ? <Badge variant="success">Added</Badge> : null}
									<span className="text-xs text-ink-2">
										{dns.isPending ? 'Checking DNS…' : st ? `${spfWords(st)} · ${dmarcWords(st)}` : "SPF couldn't check · DMARC couldn't check"}
									</span>
								</div>
								{row?.error ? (
									<div className="flex flex-wrap items-center gap-2 pl-8 text-sm text-danger" role="alert">
										<span>{n}: {row.error}</span>
										<Button size="sm" variant="secondary" disabled={running} onClick={() => retryOne(n)}>
											Try again
										</Button>
									</div>
								) : null}
								{row?.blocked ? <p className="pl-8 text-sm text-ink-2">Not added: your plan is full.</p> : null}
							</li>
						);
					})}
				</ul>
				{needsBase && chosen.filter(newOnes).length > 0 ? (
					<div className="max-w-sm space-y-1.5">
						<Label htmlFor={reportsId}>Reports go to</Label>
						<Select value={reportsHome ?? ''} onValueChange={setReportsOn}>
							<SelectTrigger id={reportsId}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{chosen.filter(newOnes).map((n) => (
									<SelectItem key={n} value={n}>
										{n}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				) : null}
				{limit ? <PlanLimitNotice limit={limit} /> : null}
				{failed && !running ? <Alert variant="warning">Some domains could not be added. Try them again, or continue without them.</Alert> : null}
				<StepFooter
					start={
						failed && !running && doneNames.length > 0 ? (
							<Button variant="secondary" onClick={continueWithout}>
								Continue without them
							</Button>
						) : undefined
					}
					end={
						<WriteButton loading={running} disabled={primary.disabled} onClick={primary.onClick}>
							{running ? 'Adding…' : primary.label}
						</WriteButton>
					}
				/>
			</div>
		</StepCard>
	);
}
