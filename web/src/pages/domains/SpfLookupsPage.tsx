import { Alert, Badge, Button } from '@ready-set-mail/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { LoadError, PageSkeleton } from '../../components/states';
import { LookupBadge, TxtRecord } from '../../components/wizard/RecordPair';
import { StepCard } from '../../components/wizard/StepCard';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { api } from '../../lib/api';
import { byHandTips, type SpfLookupsView } from '../../lib/spf-breakdown';
import { SPF_LOOKUP_ALLOWED } from '../../lib/spf-flatten';

/**
 * "Where your SPF lookups go": the by-hand way down to 10 lookups, for every workspace (it does not wait on the SPF flattening add-on). Reading only: the
 * edit itself is the SPF step of the setup wizard. ADR 0012: the step "Bring SPF down to 10 DNS lookups or fewer" must lead somewhere true.
 */
export function SpfLookupsPage() {
	const domainId = useRouteDomainId();
	const q = useQuery({ queryKey: ['spf-lookups', domainId], queryFn: () => api<SpfLookupsView>(`/api/domains/${domainId}/spf-lookups`), staleTime: 0, refetchOnMount: 'always' });
	const back = `/domains/${domainId}`;
	let body;
	if (q.isPending) body = <PageSkeleton label="Counting your lookups" />;
	else if (q.isError) body = <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not count your lookups" />;
	else if (!q.data.ok) body = <Alert variant="warning" title="We could not count them">{q.data.message}</Alert>;
	else {
		const v = q.data;
		const tips = byHandTips(v);
		body = (
			<StepCard title={v.total > SPF_LOOKUP_ALLOWED ? `Your SPF record needs ${v.total} lookups; receivers stop at ${SPF_LOOKUP_ALLOWED}` : `Your SPF record needs ${v.total} of the ${SPF_LOOKUP_ALLOWED} lookups receivers allow`}>
				<TxtRecord title={v.source === 'original' ? 'Your original record' : 'Your record'} value={v.record} badge={<LookupBadge count={v.total} />} copyable={false} />
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<caption className="sr-only">Where the lookups go</caption>
						<thead>
							<tr className="border-b border-line text-left text-ink-2">
								<th scope="col" className="py-1.5 pr-3 font-medium">Term</th>
								<th scope="col" className="py-1.5 pr-3 font-medium">Lookups</th>
								<th scope="col" className="py-1.5 font-medium">Inside it</th>
							</tr>
						</thead>
						<tbody>
							{v.items.map((i) => (
								<tr key={i.term} className="border-b border-line align-top">
									<td className="py-1.5 pr-3 font-mono [overflow-wrap:anywhere]">{i.term}</td>
									<td className="py-1.5 pr-3">{i.cost}</td>
									<td className="py-1.5 text-ink-2 [overflow-wrap:anywhere]">{i.nested.length ? i.nested.map((n) => `${n.target} (${n.cost})`).join(', ') : '–'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{v.total > SPF_LOOKUP_ALLOWED ? (
					<div className="space-y-2">
						<h3 className="text-sm font-semibold text-ink-1">What you can do</h3>
						<ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
							{tips.map((t) => (
								<li key={t}>{t}</li>
							))}
						</ul>
						<p className="text-sm text-ink-2">Change the record in the SPF step of the setup. The lookups are counted again when you save it.</p>
					</div>
				) : (
					<p className="text-sm text-ink-2">That is within the limit, so there is nothing to bring down.</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button asChild>
						<Link to={`/domains/${domainId}/setup/2`}>Edit your SPF record</Link>
					</Button>
					<Button asChild variant="secondary">
						<Link to={back}>Back to domain</Link>
					</Button>
					<Badge variant="outline">Counted just now from public DNS</Badge>
				</div>
			</StepCard>
		);
	}
	return (
		<div className="space-y-6">
			<WizardHeader backTo={back} title="Where your SPF lookups go" subtitle="Receivers allow 10 DNS lookups for an SPF record. This is what yours spends them on." />
			{body}
		</div>
	);
}
