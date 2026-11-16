import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { billingKeys } from '../../lib/billing';
import type { PlanView } from '../../lib/plan';
import { keys } from '../../lib/queries';

/** The grandfather choice, the second way: keep ONE domain free (pick which); the others pause (readable, exportable, new reports not processed). */
export function KeepOne({ plan, onClose, onDone }: { plan: PlanView; onClose: () => void; onDone: () => void }) {
	const qc = useQueryClient();
	const [pick, setPick] = useState<number | null>(plan.domains.find((d) => !d.paused)?.id ?? plan.domains[0]?.id ?? null);
	const keep = useMutation({
		mutationFn: () => api<{ kept: string; paused: number }>('/api/billing/plan/keep-one', { method: 'POST', body: { domain_id: pick } }),
		onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: billingKeys.all }), qc.invalidateQueries({ queryKey: keys.domains })]); onDone(); },
	});
	return (
		<Dialog open onOpenChange={(o) => (!o && !keep.isPending ? onClose() : undefined)}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Which domain stays free?</DialogTitle>
					<DialogDescription>The others are paused: you can still read and export them, but new reports for them are not processed. Starting pay as you go resumes them.</DialogDescription>
				</DialogHeader>
				<fieldset className="space-y-1">
					<legend className="sr-only">Domain to keep free</legend>
					{plan.domains.map((d) => (
						<label key={d.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-2">
							<input type="radio" name="keep-one" checked={pick === d.id} onChange={() => setPick(d.id)} className="size-4 accent-[var(--color-brand)]" />
							<span className="font-mono text-sm [overflow-wrap:anywhere]">{d.name}</span>
						</label>
					))}
				</fieldset>
				{keep.isError ? <Alert variant="danger" title="That did not work">{errorMessage(keep.error)}</Alert> : null}
				<DialogFooter>
					<Button variant="secondary" onClick={onClose} disabled={keep.isPending}>Cancel</Button>
					<Button loading={keep.isPending} disabled={pick === null} onClick={() => keep.mutate()}>Keep this one free</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
