import { Alert, Button, EmptyState, PageHeader, statusRank, toast } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { removalNotice, type RemovedState } from '../../lib/removal-notice';
import type { ImportedNote } from '../../lib/cloudflare';
import { CloudflareAttention } from '../../components/domain/CloudflareAttention';
import { ProofLostList, isUnproven } from '../../components/domain/ProofLost';
import { WaitingClaims } from '../../components/domain/WaitingClaims';
import { DomainRow } from '../../components/domain/DomainRow';
import { FirstDayCard, firstReportSeen } from '../../components/FirstDay';
import { HandoffCard } from '../../components/HandoffCard';
import { useHandoffs } from '../../lib/handoff';
import { ReportsNotConnected, useWorkspaceReportsNotConnected } from '../../components/ReportsNotConnected';
import { ListSkeleton, LoadError, ReadOnlyNotice, WriteButton } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { domainKeys, fetchStats, fetchSummary, useDomainSummaries } from '../../lib/domain-queries';
import { dayOneAnswer, dayOneVerdict, firstDay } from '../../lib/first-day';
import { focusDomainOf, reviewOutcome } from '../../lib/first-run';
import { useHostedConfig, useHostedStatuses, type HostedResponse } from '../../lib/hosted';
import { useDomainClaims, useDomains } from '../../lib/queries';
import { useHosted, useSession } from '../../lib/session';
import type { DailyStat, Domain, DomainCheckSummary } from '../../lib/types';
import { suffixParentOf } from '../../lib/dmarc-step';
import { listedParentFinder } from '../../lib/listed-parent';
import { reportsRefusalOf } from '../../lib/dmarc-step';
import { domainVerdict, totalsFromSummary, unavailableVerdict, workspaceAnswer, type DomainVerdict, type ReportTotals } from '../../lib/verdict';

/** Days of reports each row's evidence covers. */
const WINDOW = 30;

/** Parents first, each followed by its children. A child whose parent is not monitored stands alone. */
export function buildTree(domains: Domain[]): Array<{ root: Domain; children: Domain[] }> {
	const ids = new Set(domains.map((d) => d.id));
	const kids = new Map<number, Domain[]>();
	const roots: Domain[] = [];
	for (const d of domains) {
		if (d.parent_id !== null && d.parent_id !== undefined && ids.has(d.parent_id)) kids.set(d.parent_id, [...(kids.get(d.parent_id) ?? []), d]);
		else roots.push(d);
	}
	return roots.map((root) => ({ root, children: kids.get(root.id) ?? [] }));
}

/**
 * Every domain as a row, at any depth: each under its nearest ancestor that is in the list (following parent_id), a
 * domain whose parent is absent (or whose chain loops) as a root. Siblings and root groups are ordered by `cmp`, a group
 * ranking by its most urgent member, so every domain counted in the answer has exactly one row.
 */
export function domainRows(domains: Domain[], rank: (d: Domain) => number = () => 0): Array<{ d: Domain; parent?: string; depth: number }> {
	// The same nearest listed ancestor the domain page uses (listedParentFinder).
	const parentOf = listedParentFinder(domains);
	const kids = new Map<number, Domain[]>();
	const roots: Domain[] = [];
	for (const d of domains) {
		const p = parentOf(d);
		if (p) kids.set(p.id, [...(kids.get(p.id) ?? []), d]);
		else roots.push(d);
	}
	const best = new Map<number, number>();
	const subtree = (d: Domain): number => {
		if (best.has(d.id)) return best.get(d.id)!;
		const r = Math.min(rank(d), ...(kids.get(d.id) ?? []).map(subtree));
		best.set(d.id, r);
		return r;
	};
	const order = (a: Domain, b: Domain) => subtree(a) - subtree(b) || a.domain.localeCompare(b.domain);
	const out: Array<{ d: Domain; parent?: string; depth: number }> = [];
	const visit = (d: Domain, depth: number, parent?: string) => {
		out.push({ d, parent, depth });
		for (const c of [...(kids.get(d.id) ?? [])].sort(order)) visit(c, depth + 1, d.domain);
	};
	for (const r of [...roots].sort(order)) visit(r, 0);
	return out;
}

function AddDomainButton() {
	const { canWrite } = useSession();
	if (!canWrite) return <WriteButton variant="secondary">Add domain</WriteButton>;
	return (
		<Button asChild variant="secondary">
			<Link to="/add">
				<Plus aria-hidden />
				Add domain
			</Link>
		</Button>
	);
}

export function OverviewPage() {
	const qc = useQueryClient();
	const { canWrite, me, status, role } = useSession();
	const removed = (useLocation().state as RemovedState | null)?.removed;
	const imported = (useLocation().state as { imported?: ImportedNote } | null)?.imported;
	const list = useDomains();
	const domains = list.data ?? [];
	const claims = useDomainClaims().data ?? [];
	// Waiting for proof: pending claims, and domains held but unproven (a name with both counts once).
	const claimed = new Set(claims.map((c) => c.domain));
	const waiting = new Set([...claimed, ...domains.filter(isUnproven).map((d) => d.domain)]).size;
	// Held but unproven with no claim open: no DNS record is shown for it until Prove again runs.
	const lostProof = domains.filter((d) => isUnproven(d) && !claimed.has(d.domain)).length;
	const [exporting, setExporting] = useState(false);
	const listId = useId();
	const hostedMode = useHosted();
	// Hosted, before report intake: no domain can have reports, so say why once and make no pass-rate claim.
	const reportsOff = useWorkspaceReportsNotConnected();

	// One request for every domain's stored DNS facts and 30-day report totals (paged by 200); hosted status per domain only
	// when hosted records are on for the deployment.
	const batch = useDomainSummaries(domains.length > 0);
	const hostedOn = useHostedConfig();
	const hostedAll = useHostedStatuses(hostedOn);
	const hosted = domains.map((d): { isPending: boolean; data?: HostedResponse } => ({ isPending: hostedAll.isPending, data: hostedAll.data ? (hostedAll.data[d.id] ?? { enabled: false }) : undefined }));

	const idByName = new Map(domains.map((d) => [d.domain, d.id]));
	const summaryOf = (d: Domain): DomainCheckSummary | null | undefined => (batch.isPending ? undefined : batch.isError ? null : (batch.data.get(d.id) ?? null));
	// Each domain's listed parent (nearest ancestor in the list): a parent whose own record does not cover the name is a
	// public suffix, said plainly on the row (suffixParentOf), as on the domain page.
	const parentName = new Map(domainRows(domains).map((r) => [r.d.id, r.parent]));
	const suffixParent = (d: Domain): string | null => {
		const p = parentName.get(d.id);
		const pid = p ? idByName.get(p) : undefined;
		return p && pid !== undefined ? suffixParentOf(summaryOf(d), { domain: p, summary: batch.data?.get(pid) }) : null;
	};
	const totals: Array<ReportTotals | null | undefined> = domains.map((d) => {
		const s = summaryOf(d);
		return s ? totalsFromSummary(s, WINDOW) : s;
	});

	const verdicts: Array<DomainVerdict | null> = domains.map((d, i) => {
		const s = summaryOf(d);
		if (batch.isError) return unavailableVerdict(errorMessage(batch.error), d.domain);
		const h = hosted[i]!;
		if (s === undefined || (hostedOn && h.isPending)) return null;
		if (s === null) return unavailableVerdict('it is not in the summary yet. Reload the page.', d.domain);
		const info = hostedOn && h.data?.enabled ? h.data : null;
		// Per domain, as the server decides it (report_connect in the same batch): the domain page reads the same row.
		return domainVerdict(d, s, totals[i], info, undefined, { hostedMode, idByName, suffixParent: suffixParent(d), reportsRefusal: reportsRefusalOf(s) });
	});
	// Day one: until the first report, a new domain is "waiting for reports", not red (dayOneVerdict). The domain page keeps its own rules.
	const shownVerdicts = verdicts.map((v, i) => (v ? dayOneVerdict(v, domains[i]!, summaryOf(domains[i]!), totals[i]) : v));
	const dayOneRows = shownVerdicts.map((v, i) => !!v && v !== verdicts[i]);
	const retry = batch.isError ? () => void batch.refetch() : undefined;
	const byId = new Map(domains.map((d, i) => [d.id, { domain: d, verdict: shownVerdicts[i] ?? null, retry }]));

	// Most urgent first, a subdomain right under its parent. Until every row is known the order stays as listed,
	// so rows do not jump while they load.
	const settled = shownVerdicts.every(Boolean);
	const rank = (d: Domain) => statusRank(byId.get(d.id)?.verdict?.status ?? 'unknown');
	// Every domain has a row at any depth (a sub-subdomain under its nearest listed ancestor).
	const ordered = domainRows(domains, settled ? rank : () => 0);

	const answer = (waiting === 0 ? dayOneAnswer(domains.map((d, i) => ({ name: d.domain, verdict: shownVerdicts[i] ?? null, dayOne: dayOneRows[i] ?? false }))) : null) ?? workspaceAnswer(domains.map((d, i) => ({ name: d.domain, verdict: shownVerdicts[i] ?? null })), waiting);
	async function exportPdf() {
		setExporting(true);
		try {
			// Every summary must load, or the report would silently leave a domain out. Trends are optional.
			const [summaryData, trendResults] = await Promise.all([
				Promise.all(domains.map((d) => qc.fetchQuery({ queryKey: domainKeys.summary(d.id), queryFn: () => fetchSummary(d.id), staleTime: 0 }))),
				Promise.all(domains.map((d) => fetchStats(d.id, 90).catch(() => null))),
			]);
			const trends: Record<number, DailyStat[]> = {};
			domains.forEach((d, i) => {
				const t = trendResults[i];
				if (t) trends[d.id] = t.stats;
			});
			const { downloadPdfReport } = await import('../../lib/pdf/report');
			// The PDF's DMARC lines are the overview's verdict: the same hosted status, parents and report visibility.
			const statuses = hostedOn ? (hostedAll.data ?? (await hostedAll.refetch()).data) : undefined;
			if (hostedOn && !statuses) throw new Error('The hosted record status could not be loaded. Try again.');
			const contexts = domains.map((d) => {
				const h = statuses?.[d.id];
				return { domain: d, hosted: h?.enabled ? h : null, hostedMode, idByName, suffixParent: suffixParent(d), reportsRefusal: reportsRefusalOf(batch.data?.get(d.id)) };
			});
			await downloadPdfReport({ summaries: summaryData, contexts, trends });
			toast({ title: 'Report downloaded', description: 'email-auth-report.pdf', variant: 'success' });
		} catch (e) {
			toast({ title: 'Could not export the PDF', description: errorMessage(e), variant: 'danger' });
		} finally {
			setExporting(false);
		}
	}

	const empty = domains.length === 0 && claims.length === 0;
	// One rule for the order: whatever blocks progress or needs the person comes before "Get to your first answer": a Cloudflare connection that
	// stopped, a domain waiting for proof (above), and a domain whose status says someone must act.
	const needsAttention = shownVerdicts.some((v) => v?.status === 'attention' || v?.status === 'approval');
	// The first day (D1): the domain the first run was about, from what the server knows. Where the old stepper stood, with the same rule for order.
	const focus = focusDomainOf(domains, me?.workspace_id ?? null);
	const dayState = canWrite
		? firstDay({ domain: focus, claims, summary: focus ? summaryOf(focus) : undefined, arrivedSeen: firstReportSeen(me?.workspace_id ?? null), applied: reviewOutcome(me?.workspace_id ?? null) === 'applied' })
		: null;
	// H2: while a teammate finishes this domain (until its records are live), their progress replaces the first-day card.
	const handoffs = useHandoffs(canWrite && hostedMode);
	const focusName = focus?.domain ?? claims.find((c) => c.status === 'pending')?.domain;
	const handoff = focusName ? (handoffs.data ?? []).filter((h) => h.domain === focusName).sort((a, b) => b.sent_at - a.sent_at)[0] : undefined;
	const recordsLive = dayState && ['live', 'quiet', 'arrived', 'reports_off'].includes(dayState.kind);
	const stepper = handoff && !recordsLive ? <HandoffCard handoff={handoff} state={dayState} canResend={role === 'owner'} /> : dayState ? <FirstDayCard state={dayState} email={me?.user?.email} emailCheck={status?.email_check !== false} workspaceId={me?.workspace_id ?? null} /> : null;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Domains"
				actions={
					<>
						{domains.length > 0 ? (
							<Button variant="secondary" loading={exporting} onClick={exportPdf}>
								<Download aria-hidden />
								{exporting ? 'Generating…' : 'Export PDF'}
							</Button>
						) : null}
						{!empty || !canWrite ? <AddDomainButton /> : null}
					</>
				}
			/>
			<ReadOnlyNotice />
			{imported ? <Alert variant={imported.ok ? 'success' : 'warning'} title="Cloudflare import">{imported.text}</Alert> : null}
			{removed && removed.kept.length > 0 ? (
				<Alert variant="warning" title="Domain removed, some DNS records kept">
					{removalNotice(removed.domain, removed.kept)}
				</Alert>
			) : null}

			{list.isPending ? (
				<ListSkeleton rows={3} label="Loading domains" />
			) : list.isError ? (
				<LoadError error={list.error} onRetry={() => void list.refetch()} title="Could not load your domains" />
			) : (
				<>
					<div className="space-y-1">
						<p className="text-lg font-semibold tracking-tight text-ink-1 [overflow-wrap:anywhere] sm:text-xl" aria-live="polite" data-testid="am-i-done">
							{answer}
						</p>
						{!empty ? (
							<p className="max-w-prose text-sm text-ink-2">
								{reportsOff ? 'Each domain below says what public DNS shows, and who acts next. Most urgent first.' : `Each domain below says what public DNS and its last ${WINDOW} days of reports show, and who acts next. Most urgent first.`}
							</p>
						) : null}
					</div>

					{/* What blocks progress comes first: a domain waiting for proof, a Cloudflare connection that stopped working. */}
					<ProofLostList domains={domains} canWrite={canWrite} />
					{canWrite ? <CloudflareAttention /> : null}
					<WaitingClaims claims={claims.filter((c) => !domains.some((d) => isUnproven(d) && d.domain === c.domain))} canWrite={canWrite} />

					{!needsAttention && stepper}

					{empty && !canWrite ? (
						<EmptyState
							title="This workspace has no domains yet"
							description="An owner or admin adds them. Each domain then appears here with its level, what is true now and what to do next."
						/>
					) : null}

					{domains.length > 0 ? (
						<section aria-labelledby={listId} className="space-y-3">
							<h2 id={listId} className="sr-only">
								Your domains
							</h2>
							{reportsOff ? <ReportsNotConnected /> : null}
							<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1">
								{ordered.map(({ d, parent, depth }) => {
									const row = byId.get(d.id)!;
									return <DomainRow key={d.id} domain={d} parent={parent} depth={depth} verdict={row.verdict} canWrite={canWrite} onRetry={row.retry} hideEvidence={reportsOff} />;
								})}
							</ul>
						</section>
					) : null}

					{needsAttention && stepper}
				</>
			)}
		</div>
	);
}
