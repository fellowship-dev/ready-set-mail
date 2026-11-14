import { Button, Checkbox, FieldError, Skeleton } from '@ready-set-mail/ui';
import { useState } from 'react';
import { LoadError, WriteButton } from '../../../components/states';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { errorMessage } from '../../../lib/api';
import { useCfZones, useSetZones, type CfConnection } from '../../../lib/cloudflare';

export const PRETICK_LIMIT = 10;

/** Step 2: which zones Ready Set Mail may touch. Everything outside this list is refused by the server. */
export function ZonesStep({ connection, onNext }: { connection: CfConnection; onNext: () => void }) {
	const zones = useCfZones(connection);
	const save = useSetZones();
	const [picked, setPicked] = useState<Set<string> | null>(null);

	if (zones.isPending) return <StepCard title="Choose zones"><Skeleton className="h-24 w-full" role="status" aria-label="Loading your Cloudflare zones" /></StepCard>;
	if (zones.isError) return <LoadError error={zones.error} onRetry={() => void zones.refetch()} title="Could not list your Cloudflare zones" />;

	const list = zones.data;
	// What was allowed before wins; otherwise every zone when there are few, none when there are many.
	const before = list.filter((z) => z.allowed).map((z) => z.id);
	const selected = picked ?? new Set(before.length > 0 ? before : list.length <= PRETICK_LIMIT ? list.map((z) => z.id) : []);
	const toggle = (id: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(id);
		else next.delete(id);
		setPicked(next);
	};

	return (
		<StepCard title="Choose zones">
			<div className="space-y-4">
				<p className="max-w-prose text-sm text-ink-2">Ready Set Mail only writes in the zones you tick. You can change this later.</p>
				{list.length === 0 ? (
					<p className="text-sm text-ink-2">This Cloudflare account has no zones the connection can see.</p>
				) : (
					<>
						<div>
							<Button variant="ghost" size="sm" onClick={() => setPicked(new Set(list.map((z) => z.id)))}>
								Select all
							</Button>
						</div>
						<ul className="divide-y divide-line rounded-lg border border-line">
							{list.map((z) => (
								<li key={z.id}>
									<label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
										<Checkbox checked={selected.has(z.id)} onCheckedChange={(c) => toggle(z.id, c === true)} />
										<span className="min-w-0 font-medium [overflow-wrap:anywhere]">{z.name}</span>
									</label>
								</li>
							))}
						</ul>
					</>
				)}
				{save.isError ? <FieldError>{errorMessage(save.error)}</FieldError> : null}
				<StepFooter
					end={
						<WriteButton
							loading={save.isPending}
							disabled={selected.size === 0}
							onClick={() => save.mutate({ connectionId: connection.id, zoneIds: [...selected] }, { onSuccess: onNext })}
						>
							{save.isPending ? 'Saving…' : 'Next'}
						</WriteButton>
					}
				/>
			</div>
		</StepCard>
	);
}
