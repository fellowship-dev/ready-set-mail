import { Alert, Button, Skeleton, type StatusKind } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { hasReportAddress } from '../../lib/dmarc-record';
import { useCheckSummary } from '../../lib/domain-queries';
import { useHostedLevelInput } from '../../lib/hosted';
import { useReportsAvailable } from '../../lib/report-address';
import { useSession } from '../../lib/session';
import type { Domain } from '../../lib/types';
import { dmarcStepsFor, totalsFromSummary } from '../../lib/verdict';

/** The shared rule's step as an alert, in the status words' tones. */
export const STEP_ALERT: Record<StatusKind, 'info' | 'success' | 'warning' | 'danger'> = { attention: 'danger', improve: 'warning', approval: 'info', unknown: 'info', gathering: 'info', prepared: 'info', verified: 'success', note: 'info' };

/**
 * The next DMARC step for a domain, from the one rule the overview and the domain page use (dmarcStepsFor): for example
 * "Wait for DMARC reports before moving to p=quarantine" or "Approve moving DMARC to p=quarantine". Nothing while loading
 * fails quietly: the page around it still says what DNS shows.
 */
export function NextDmarcStep({ domain }: { domain: Pick<Domain, 'id' | 'domain' | 'rua_address'> }) {
	const summary = useCheckSummary(domain.id);
	const hosted = useHostedLevelInput(domain.id);
	const reportsAvailable = useReportsAvailable(hasReportAddress(domain.rua_address) ? undefined : domain.id);
	const { canWrite } = useSession();
	if (summary.isPending || hosted.pending || reportsAvailable === undefined) return <Skeleton className="h-16 w-full" />;
	if (summary.isError) return null;
	const step = dmarcStepsFor(domain, summary.data, totalsFromSummary(summary.data), hosted.info, null, null, reportsAvailable)[0];
	if (!step) return null;
	return (
		<Alert variant={STEP_ALERT[step.status]} title={`Next: ${step.do}`}>
			<p>{step.why}</p>
			{step.where === 'dmarc-wizard' && canWrite ? (
				<Button asChild size="sm" variant="secondary" className="mt-3">
					<Link to={`/domains/${domain.id}/dmarc-wizard`}>Review the change</Link>
				</Button>
			) : null}
		</Alert>
	);
}
