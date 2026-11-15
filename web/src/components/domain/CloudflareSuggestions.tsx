import { Alert, Button } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
export function CloudflareSuggestions() {
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
