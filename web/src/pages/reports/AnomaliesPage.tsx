import { Button, EmptyState, PageHeader } from '@ready-set-mail/ui';
import { ReportsNotConnected, useReportsNotConnected } from '../../components/ReportsNotConnected';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useState } from 'react';
import { BackLink, SourceTable, WindowPills, useRouteDomainId } from '../../components/reports';
import { ListSkeleton, LoadError, Section } from '../../components/states';
import { api } from '../../lib/api';
import { useDomain } from '../../lib/queries';
import { DEFAULT_WINDOW, isFailing, isOneCheck, plural, splitActive, verdictLead, verdictLeadSentence, type WindowDays } from '../../lib/reports';
import type { AnomalySource } from '../../lib/types';

export function AnomaliesPage() {
	const id = useRouteDomainId();
	const { domain } = useDomain(id);
	const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW);
	// Hosted, before report intake: "no anomalies" would be a pass nobody measured.
	const reportsOff = useReportsNotConnected(domain);

	const q = useQuery({
		queryKey: ['anomalies', id, days],
		queryFn: () => api<{ days: number; domain: string; anomalies: AnomalySource[]; unrecorded_reports?: number }>(`/api/domains/${id}/anomalies?days=${days}`),
		enabled: !Number.isNaN(id),
	});
	const name = domain?.domain ?? q.data?.domain;
	const rows = q.data?.anomalies ?? [];
	const { active, older } = splitActive(rows.filter(isFailing));
	const oneCheck = rows.filter(isOneCheck);
	// Some mail has no recorded verdict: the page says so first, from the function the day's report page uses too.
	const lead = verdictLead(rows, q.data?.unrecorded_reports);

	return (
		<div className="space-y-6">
			<PageHeader
				eyebrow={<BackLink to={`/domains/${id}`}>{name ?? 'Back'}</BackLink>}
				title="Anomalies"
				description="Sources whose mail failed DMARC: neither SPF nor DKIM passed and aligned with the From domain."
				actions={<WindowPills value={days} onChange={setDays} />}
			/>

			{reportsOff ? (
				<ReportsNotConnected domain={domain?.domain} domainId={domain?.id} />
			) : q.isPending ? (
				<ListSkeleton rows={3} label="Loading anomalies" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load anomalies" />
			) : active.length + older.length + oneCheck.length === 0 ? (
				<EmptyState
					title={lead ? verdictLeadSentence(lead).replace(/\.$/, '') : `No source failed DMARC in the last ${days} days`}
					description={lead ? `Reports stored before Ready Set Mail kept each receiver's DMARC verdict stay without one when the original report is not kept. Among the reports that have a verdict, no source failed in the last ${days} days.` : 'No source in the reports received for this window failed DMARC. If no reports arrived, there is nothing to judge yet, so check what was received.'}
					action={
						<Button asChild variant="secondary">
							<Link to={`/domains/${id}/reports`}>See received reports</Link>
						</Button>
					}
				/>
			) : (
				<>
					{lead ? <p className="text-base font-medium text-ink-1">{verdictLeadSentence(lead)}</p> : null}
					{active.length > 0 ? (
						<Section title={`Active: ${plural(active.length, 'source')}`} description="Failing within the last 2 days.">
							<SourceTable sources={active} domainId={id} label="Active anomalies" />
						</Section>
					) : null}
					{older.length > 0 ? (
						<Section title={`Older: ${plural(older.length, 'source')}`} description="Not seen in 2+ days, may be resolved.">
							<SourceTable sources={older} domainId={id} label="Older anomalies" />
						</Section>
					) : null}
					{oneCheck.length > 0 ? (
						<Section title="Passed, but one check failed" description="DMARC passed on SPF or DKIM alone. Worth fixing so there is a backup.">
							<SourceTable sources={oneCheck} domainId={id} label="Sources that passed on one check" />
						</Section>
					) : null}
				</>
			)}
		</div>
	);
}
