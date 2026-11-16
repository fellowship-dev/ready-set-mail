import { StatusDot, cn } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { hasReportAddress } from '../lib/dmarc-record';
import { useDomains } from '../lib/queries';
import { useDomainSummaries } from '../lib/domain-queries';
import { reportsRefusalOf } from '../lib/dmarc-step';
import { useReportsRefusal } from '../lib/report-address';
import { useHosted } from '../lib/session';
import { HELP_PRIORITY, TalkToMax } from './TalkToMax';
import { ConnectReports } from './reports/ConnectReports';

/**
 * Hosted only: a domain whose DMARC reports cannot reach this dashboard, because it has no report address (hosted
 * report intake is not connected). Report screens then say so instead of showing empty charts or "nothing failing".
 * Always false on a self-hosted instance, whose screens stay as they are.
 */
export function useReportsNotConnected(domain: { rua_address?: string | null } | null | undefined): boolean {
	const hosted = useHosted();
	return hosted && !!domain && !hasReportAddress(domain.rua_address);
}

/** Hosted only: no domain in this workspace has a report address, so workspace-wide report views have nothing to show. */
export function useWorkspaceReportsNotConnected(): boolean {
	const hosted = useHosted();
	const domains = useDomains();
	return hosted && !!domains.data && domains.data.every((d) => !hasReportAddress(d.rua_address));
}

/**
 * "Reports not connected yet", in place of report data: what that means, what still works from live DNS, and a
 * person to talk to. Status "unknown" (dashed circle), never a pass: without reports nobody can say every sender passes.
 * With `domainId` (one domain) and report intake on, it also offers Connect reports (ConnectReports `bare`: the action only).
 */
/** Reports cannot come to this server for the domain at all (another workspace runs report intake here, or there is none). */
export const cannotCome = (kind: string | undefined) => kind === 'operator_only' || kind === 'unavailable';

/**
 * Why reports cannot be connected: for one domain from its own summary (`report_connect`), for the workspace when every
 * domain gives the same "cannot come here" answer. Null while unknown or when they can be connected.
 */
function useRefusal(id: number | undefined) {
	const hosted = useHosted();
	const one = useReportsRefusal(id ?? 0, id !== undefined);
	const batch = useDomainSummaries(id === undefined && hosted);
	if (id !== undefined) return one.refusal;
	const rows = [...(batch.data?.values() ?? [])].map((s) => reportsRefusalOf(s));
	return rows.length > 0 && rows.every((r) => cannotCome(r?.kind)) ? rows[0]! : null;
}

/**
 * On a page about every domain: the way to connect reports for the domains that can. One domain: its own action. Several: a link to each
 * domain's page, where its reports panel is first.
 */
function ConnectEach() {
	const domains = useDomains();
	const batch = useDomainSummaries(true);
	const open = (domains.data ?? []).filter((d) => !hasReportAddress(d.rua_address) && !cannotCome(reportsRefusalOf(batch.data?.get(d.id))?.kind));
	if (open.length === 0) return null;
	if (open.length === 1) return <ConnectReports domain={{ id: open[0]!.id, domain: open[0]!.domain }} bare />;
	const shown = open.slice(0, 5);
	return (
		<ul className="space-y-1 text-sm" aria-label="Connect reports">
			{shown.map((d) => (
				<li key={d.id} className="flex flex-wrap items-baseline gap-x-3">
					<span className="font-mono text-ink-1 [overflow-wrap:anywhere]">{d.domain}</span>
					<Link to={`/domains/${d.id}`} className="font-medium text-brand-ink underline underline-offset-4">
						Connect reports
					</Link>
				</li>
			))}
			{open.length > shown.length ? <li className="text-ink-2">and {open.length - shown.length} more: open the domain.</li> : null}
		</ul>
	);
}

export function ReportsNotConnected({ domain, domainId, refusalId, className }: { domain?: string; domainId?: number; /** The domain whose refusal decides the wording, when no Connect action is shown (setup). */ refusalId?: number; className?: string }) {
	const refusal = useRefusal(refusalId ?? domainId);
	if (refusal && cannotCome(refusal.kind)) {
		// The domain page's words (the shared rule's check-senders step): nothing suggests that reports could be connected.
		const who = domain ? <strong className="font-mono font-medium text-ink-1 [overflow-wrap:anywhere]">{domain}</strong> : 'your domains';
		return (
			<section aria-label="Reports" className={cn('space-y-2 rounded-lg border border-line bg-surface-2 p-4 sm:p-5', className)} data-testid="reports-not-connected" data-refusal={refusal.kind}>
				<StatusDot status="unknown" label="Reports are not available" className="font-semibold" />
				<p className="text-sm text-ink-2">
					Reports are not available for {who}, so nobody here can confirm that every service sending as {domain ? 'it' : 'them'} passes: pass rates, failing senders and whether
					it is safe to enforce cannot be shown. Check each service that sends as {domain ? 'it' : 'your domains'} (your mail provider, newsletter, invoicing and support tools)
					before you tighten the policy.
				</p>
				<p className="text-sm text-ink-2">Still checked from live DNS: your SPF, DKIM and DMARC records, each domain&apos;s level, and the exact records to fix.</p>
				<TalkToMax priority={HELP_PRIORITY.reportsNotConnected} lead="Want reports for your domains?" about="about reports" />
			</section>
		);
	}
	return (
		<section aria-label="Reports" className={cn('space-y-2 rounded-lg border border-line bg-surface-2 p-4 sm:p-5', className)} data-testid="reports-not-connected">
			<StatusDot status="unknown" label="Reports not connected yet" className="font-semibold" />
			<p className="text-sm text-ink-2">
				Mail servers send DMARC reports to the address listed in a domain&apos;s DMARC record. {domain ? <strong className="font-mono font-medium text-ink-1 [overflow-wrap:anywhere]">{domain}</strong> : 'Your domains'}{' '}
				{domain ? 'has' : 'have'} no Ready Set Mail report address yet, so no reports arrive here. Until they do, nobody can confirm that every sender passes: pass rates, failing
				senders and whether it is safe to enforce cannot be shown.
			</p>
			<p className="text-sm text-ink-2">Still checked from live DNS: your SPF, DKIM and DMARC records, each domain&apos;s level, and the exact records to fix.</p>
			{domain && domainId !== undefined ? <ConnectReports domain={{ id: domainId, domain }} bare /> : domain === undefined ? <ConnectEach /> : null}
			<TalkToMax priority={HELP_PRIORITY.reportsNotConnected} lead="Want reports for your domains?" about="about connecting them" />
		</section>
	);
}
