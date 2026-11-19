import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Link } from 'react-router';
import { statusLine } from '../../lib/spf-flatten';
import type { SpfFlatStatus } from '../../lib/types';

/** One line under the page header while flattening is on (or was): its state, and the way to the whole state (the flattening page is the status home). */
export function SpfStatusLine({ domainId, status }: { domainId: number; status: SpfFlatStatus | undefined }) {
	const line = status ? statusLine(status) : null;
	if (!line) return null;
	const Icon = line.tone === 'ok' ? CheckCircle2 : line.tone === 'wait' ? Clock : AlertTriangle;
	return (
		<p data-testid="spf-status-line" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-1">
			<Icon aria-hidden className={line.tone === 'ok' ? 'size-4 text-success' : line.tone === 'wait' ? 'size-4 text-info' : 'size-4 text-warning'} />
			<span>{line.text}</span>
			<Link to={`/domains/${domainId}/spf-flatten`} className="rounded-sm font-medium text-brand-ink underline underline-offset-4">
				Details
			</Link>
		</p>
	);
}
