import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { formatNumber } from '../../lib/format';
import { plural } from '../../lib/reports';
import type { FailingSources as FailingSourcesData } from '../../lib/types';
import { ListSkeleton, LoadError, Section } from '../states';
import type { UseQueryResult } from '@tanstack/react-query';

/** The one-check and not-recorded sentences of the last 7 days (also the summary of the disclosure when nothing failed). */
export const oneCheckLine = (n: number): string => `${plural(n, 'source')} passed DMARC on one check only in the last 7 days: worth fixing so there is a backup.`;
export const notRecordedLine = (n: number, messages: number): string =>
	`${plural(n, 'source')} (${formatNumber(messages)} messages) are in reports stored before Ready Set Mail kept each receiver's DMARC verdict: verdict not recorded.`;

/** The sources that failed DMARC (7 days), then quiet lines for those that passed on one check only or have no recorded verdict. Nothing when there is none of either. */
export function FailingSources({ domainId, q }: { domainId: number; q: UseQueryResult<FailingSourcesData> }) {
	if (q.isPending) return <Section title="Top failing sources"><ListSkeleton rows={1} label="Loading failing sources" /></Section>;
	if (q.isError) return <Section title="Top failing sources"><LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load failing sources" /></Section>;
	const { sources, one_check: one, not_recorded: unrecorded } = q.data;
	const lines = (
		<div className="space-y-1 text-sm text-ink-2">
			{one.sources > 0 ? (
				<p>
					{oneCheckLine(one.sources)}{' '}
					<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/anomalies`}>
						Anomalies
					</Link>
				</p>
			) : null}
			{unrecorded.sources > 0 ? <p>{notRecordedLine(unrecorded.sources, unrecorded.messages)}</p> : null}
		</div>
	);
	if (sources.length === 0) return one.sources > 0 || unrecorded.sources > 0 ? lines : null;
	return (
		<>
		<Section
			title="Top failing sources"
			description="Servers whose mail failed DMARC in the last 7 days."
			actions={
				<span className="flex gap-4 text-sm">
					<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/anomalies`}>
						Anomalies
					</Link>
					<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/explore`}>
						Explore sources
					</Link>
				</span>
			}
		>
			<Table label="Top failing sources">
				<TableHeader>
					<TableRow>
						<TableHead>Source</TableHead>
						<TableHead>Sending as</TableHead>
						<TableHead className="text-right">Failed messages</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sources.map((src) => {
						const name = src.org ?? src.base_domain;
						return (
							<TableRow key={src.source_ip}>
								<TableCell>
									{name ? <span className="block font-semibold">{name}</span> : null}
									<code className="font-mono text-xs text-ink-2">{src.source_ip}</code>
								</TableCell>
								<TableCell className="[overflow-wrap:anywhere]">{src.header_from ?? 'unknown'}</TableCell>
								<TableCell className="text-right tabular-nums">{formatNumber(src.total)}</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</Section>
		{one.sources > 0 || unrecorded.sources > 0 ? lines : null}
		</>
	);
}
