import { Alert, Button } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ZoneChoice } from '../billing/PaidAdd';
import { api } from '../../lib/api';
import { useBilling } from '../../lib/billing';
import { planEnforced, usd, WORDS, type PaidPreview } from '../../lib/plan';
import { useState } from 'react';
import { PlanLimitNotice, planLimitOf } from '../PlanLimitNotice';
import { errorMessage } from '../../lib/api';
import { accountLabel, activeConnection, cfKeys, importAll, importSummary, useCfConnections, useCfSuggestions, type CfSuggestion } from '../../lib/cloudflare';
import { keys } from '../../lib/queries';
import { useSession } from '../../lib/session';

/**
 * Zones of the connected Cloudflare accounts that are not domains of the workspace yet, one click each. Nothing is added by itself after
 * the first import: a new zone shows up here, and so does one the person removed (marked as such).
 */
export function CloudflareSuggestions({ onPaid }: { onPaid?: (names: string[]) => void } = {}) {
	const plan = useBilling().data?.plan ?? null;
	// Hosted plan: the zones that did not fit the free domain are paid domains, picked here and confirmed once for all of them.
	if (planEnforced(plan) && plan.paid_available) return <AlsoInCloudflare owner={plan.can_manage} onPaid={onPaid} />;
	return <AllSuggestions />;
}

/** "Also in your Cloudflare account": pick any of the other zones, then ONE confirm for the total (the Add domain page shows it). Shown once: it can be dismissed. */
function AlsoInCloudflare({ owner, onPaid }: { owner: boolean; onPaid?: (names: string[]) => void }) {
	const { canWrite } = useSession();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const plan = useBilling().data?.plan ?? null;
	const conns = useCfConnections(canWrite);
	const working = !!conns.data && activeConnection(conns.data) !== null;
	const q = useQuery({ queryKey: [...cfKeys.suggestions, 'plan'], enabled: canWrite && working, retry: false, staleTime: 60_000, queryFn: () => api<{ suggestions: CfSuggestion[]; dismissed: boolean }>('/api/cloudflare/suggestions') });
	const [picked, setPicked] = useState<string[]>([]);
	const dismiss = useMutation({ mutationFn: () => api('/api/cloudflare/suggestions/dismiss', { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: cfKeys.suggestions }) });
	const list = q.data?.suggestions ?? [];
	// What is asked of the owner for these names: a confirm (they are paid), or nothing (they fit the free domain: added the plain way).
	const choose = useMutation({
		mutationFn: async () => {
			const prev = await api<PaidPreview>(`/api/billing/domains/preview?${picked.map((d) => `domain=${encodeURIComponent(d)}`).join('&')}`);
			if (prev.reason !== 'free') return 'paid' as const; // a confirm, or the sentence that says why not (payment problem, waiting for the bank)
			for (const s of list.filter((x) => picked.includes(x.name))) await importAll(s.connection_id, [s.zone_id]);
			return 'free' as const;
		},
		onSuccess: (kind) => {
			if (kind === 'paid') { onPaid?.(picked); return; }
			void qc.invalidateQueries({ queryKey: ['domains'] });
			void qc.invalidateQueries({ queryKey: cfKeys.suggestions });
			navigate('/');
		},
	});
	if (!canWrite || !working || q.data?.dismissed || list.length === 0) return null;
	const unit = plan?.price ?? null;
	return (
		<section aria-labelledby="cf-also" className="space-y-3 rounded-lg border border-line p-4">
			<h2 id="cf-also" className="text-base font-semibold tracking-tight">Also in your Cloudflare account</h2>
			<p className="text-sm text-ink-2">{owner ? `Add: ${unit ? `${usd(unit.amount, unit.currency)} a ${unit.interval} each` : 'billed monthly'}. Subdomains included. You confirm the total once.` : WORDS.askOwner}</p>
			{owner ? (
				<>
					<div className="divide-y divide-line">{list.map((s) => <ZoneChoice key={s.zone_id} name={s.name} checked={picked.includes(s.name)} onChange={(v) => setPicked((p) => (v ? [...p, s.name].slice(0, 10) : p.filter((n) => n !== s.name)))} />)}</div>
					{choose.isError ? <p className="text-sm text-danger">{errorMessage(choose.error)}</p> : null}
					<div className="flex flex-wrap gap-2">
						<Button disabled={picked.length === 0} loading={choose.isPending} onClick={() => choose.mutate()}>{picked.length > 1 ? `Add ${picked.length} domains` : 'Add'}</Button>
						<Button variant="secondary" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>Not now</Button>
					</div>
				</>
			) : null}
		</section>
	);
}

function AllSuggestions() {
	const { canWrite } = useSession();
	const qc = useQueryClient();
	const conns = useCfConnections(canWrite);
	const working = !!conns.data && activeConnection(conns.data) !== null;
	const q = useCfSuggestions(canWrite && working);
	// Said where the person is looking, in the page: a toast would float over the list and whatever is under it.
	const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
	const add = useMutation({
		mutationFn: (s: CfSuggestion) => importAll(s.connection_id, [s.zone_id]).then((r) => r.totals),
		onSuccess: (totals) => {
			void qc.invalidateQueries({ queryKey: keys.domains });
			void qc.invalidateQueries({ queryKey: ['auth-status'] });
			void qc.invalidateQueries({ queryKey: cfKeys.suggestions });
			void qc.invalidateQueries({ queryKey: cfKeys.connections });
			setNote({ text: importSummary(totals), ok: totals.imported.length > 0 });
		},
	});
	const list = q.data ?? [];
	if (!canWrite || !working || (list.length === 0 && !note)) return null;
	const limit = add.isError ? planLimitOf(add.error) : null;
	return (
		<section aria-labelledby="cf-suggestions" className="space-y-3 rounded-lg border border-line p-4">
			<h2 id="cf-suggestions" className="text-base font-semibold tracking-tight">
				In your Cloudflare account
			</h2>
			{note ? <Alert variant={note.ok ? 'success' : 'warning'} title="Cloudflare import">{note.text}</Alert> : null}
			<p className="text-sm text-ink-2">These domains are not added yet. Adding one verifies it through Cloudflare and changes nothing in your DNS.</p>
			<ul className="divide-y divide-line">
				{list.map((s) => {
					const account = accountLabel(conns.data, s.account_id);
					return (
						<li key={s.zone_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
							<div className="min-w-0">
								<p className="font-mono text-sm font-medium [overflow-wrap:anywhere]">{s.name}</p>
								{account || s.removed ? <p className="text-xs text-ink-2">{[account ? `Cloudflare account ${account}` : null, s.removed ? 'You removed it earlier' : null].filter(Boolean).join(' · ')}</p> : null}
							</div>
							<Button size="sm" variant="secondary" aria-label={`Add ${s.name}`} loading={add.isPending && add.variables?.zone_id === s.zone_id} disabled={add.isPending} onClick={() => add.mutate(s)}>
								Add
							</Button>
						</li>
					);
				})}
			</ul>
			{limit ? <PlanLimitNotice limit={limit} /> : add.isError ? <p className="text-sm text-danger">{errorMessage(add.error)}</p> : null}
		</section>
	);
}
