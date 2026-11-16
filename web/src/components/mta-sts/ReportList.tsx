import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
import { failureWords, formatPeriod } from '../../lib/mta-sts';
import type { MtaStsReport } from '../../lib/types';

const sessions = (r: MtaStsReport) => ({ ok: r.sts_successful_sessions ?? r.successful_sessions, bad: r.sts_failed_sessions ?? r.failed_sessions });
const types = (r: MtaStsReport) => (r.failure_types.length ? r.failure_types.map(failureWords).join('; ') : 'none');

/** TLS reports of the last 30 days: reporter, period, successful and failed sessions, failure types. A table from `sm`, a list below it, so no screen scrolls sideways. */
export function ReportList({ reports }: { reports: MtaStsReport[] }) {
	if (reports.length === 0) {
		return <EmptyState title="No TLS report yet" description="Senders usually send one a day after they deliver mail to you." />;
	}
	const mixed = reports.some((r) => r.sts_successful_sessions === null);
	return (
		<div data-testid="tls-reports" className="space-y-2">
			<div className="hidden sm:block">
				<Table label="TLS reports, last 30 days">
					<TableHeader>
						<TableRow>
							<TableHead>Reporter</TableHead>
							<TableHead>Period</TableHead>
							<TableHead className="text-right">Successful</TableHead>
							<TableHead className="text-right">Failed</TableHead>
							<TableHead>Failure types</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{reports.map((r) => (
							<TableRow key={r.id}>
								<TableCell className="font-medium [overflow-wrap:anywhere]">{r.reporter}</TableCell>
								<TableCell>{formatPeriod(r.period_start, r.period_end)}</TableCell>
								<TableCell className="text-right tabular-nums">{sessions(r).ok.toLocaleString()}</TableCell>
								<TableCell className="text-right tabular-nums">{sessions(r).bad.toLocaleString()}</TableCell>
								<TableCell className="[overflow-wrap:anywhere]">{types(r)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<ul className="space-y-2 sm:hidden" aria-label="TLS reports, last 30 days">
				{reports.map((r) => (
					<li key={r.id} className="space-y-1 rounded-lg border border-line bg-surface-1 p-3 text-sm">
						<p className="font-medium text-ink-1 [overflow-wrap:anywhere]">{r.reporter}</p>
						<p className="text-ink-2">{formatPeriod(r.period_start, r.period_end)}</p>
						<p className="text-ink-1">
							<span className="tabular-nums">{sessions(r).ok.toLocaleString()}</span> successful · <span className="tabular-nums">{sessions(r).bad.toLocaleString()}</span> failed
						</p>
						<p className="text-ink-2 [overflow-wrap:anywhere]">Failure types: {types(r)}</p>
					</li>
				))}
			</ul>
			{mixed ? <p className="text-xs text-ink-2">Reports received before this page counted MTA-STS sessions separately show all their sessions.</p> : null}
		</div>
	);
}
