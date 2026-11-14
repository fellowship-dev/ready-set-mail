import { HealthReportSection, useHealthReport } from './HealthReportSection';
import { Alert, Badge, Button, EmptyState, LevelLadder, PageHeader, Skeleton, StatusLabel, Tabs, TabsList, TabsTrigger } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, Settings } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useDomainId } from '../../app';
import { DailyChart } from '../../components/domain/DailyChart';
import { CopyField } from '../../components/domain/CopyField';
import { DnsRecords } from '../../components/domain/DnsRecords';
import { DnsTools } from '../../components/domain/DnsTools';
import { DoThisNext } from '../../components/domain/DoThisNext';
import { FailingSources } from '../../components/domain/FailingSources';
import { HostedPanel } from '../../components/hosted/HostedPanel';
import { ConnectReports } from '../../components/reports/ConnectReports';
import { Rollout } from '../../components/domain/Rollout';
import { ReportsNotConnected, useReportsNotConnected } from '../../components/ReportsNotConnected';
import { Disclosure, ListSkeleton, LoadError, PageSkeleton, ReadOnlyNotice, Section } from '../../components/states';
import { actionsPending, domainActions } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { useHostedLevelInput } from '../../lib/hosted';
import { dmarcStepsFor, domainVerdict, totalsFromSummary, unavailableVerdict, type ReportTotals } from '../../lib/verdict';
import { dmarcRecordProblem, enforcementLevel, invalidDmarcSp, parseDmarcPolicy, parseDmarcSp } from '../../lib/dmarc-record';
import { recordAlignment } from '../../lib/dmarc-coverage';
import { spTag, sumStats, wizardProgress } from '../../lib/dmarc';
import { domainKeys, useCheckSummary, useDnsCheck, useDomainSummaries, useFailingSources, useMtaSts, useOnboardingStatus, useRolloutNext, useSpfFlatten, useStats, useWizardState } from '../../lib/domain-queries';
import { listedParentFinder } from '../../lib/listed-parent';
import { useReportsRefusal } from '../../lib/report-address';
import type { ReportsRefusal } from '../../lib/dmarc-step';
import { emptyReportsMessage, emptyReportsState, type ReportVisibilityFields } from '../../lib/uncounted';
import type { StatusKind } from '@ready-set-mail/ui';
import { formatNumber } from '../../lib/format';
import { useDomain, useDomains } from '../../lib/queries';
import { hasReportAddress } from '../../lib/dmarc-record';
import { useHosted, useSession } from '../../lib/session';
import type { Domain, DomainCheckSummary } from '../../lib/types';
import { suffixParentOf } from '../../lib/dmarc-step';
import { inForceSentence, policyInForce } from '@ready-set-mail/dns-checks/dmarc-next-step';

const WINDOWS = [7, 30, 60] as const;
/** The shared rule's step as an alert, in the status words' tones. */
const STEP_ALERT: Record<StatusKind, 'info' | 'success' | 'warning' | 'danger'> = { attention: 'danger', improve: 'warning', approval: 'info', unknown: 'info', gathering: 'info', prepared: 'info', verified: 'success', note: 'info' };

type Policy = 'none' | 'quarantine' | 'reject';
const asPolicy = (p: string | null | undefined): Policy | null => (p === 'none' || p === 'quarantine' || p === 'reject' ? p : null);

function PolicyBadge({ policy }: { policy: Policy }) {
	const variant = policy === 'reject' ? 'success' : policy === 'quarantine' ? 'warning' : 'danger';
	return <Badge variant={variant}>p={policy}</Badge>;
}

/**
 * A listed subdomain's DMARC, from its stored check (the overview reads the same): a policy only when one was read, else
 * what is known instead. Never p=none without evidence.
 */
function ChildPolicyBadge({ summary }: { summary: DomainCheckSummary | null | undefined }) {
	if (summary === undefined) return <Badge variant="outline">Checking DMARC…</Badge>;
	const policy = asPolicy(summary?.dmarc_policy);
	if (policy) return <PolicyBadge policy={policy} />;
	if (summary?.dmarc_issue === 'multiple') return <Badge variant="outline">Multiple DMARC records</Badge>;
	if (summary?.dmarc_issue === 'invalid') return <Badge variant="outline">DMARC record is invalid</Badge>;
	if (!summary?.dns_checked_at) return <Badge variant="outline">DMARC not checked yet</Badge>;
	return <Badge variant="outline">No DMARC record found</Badge>;
}

/** "No reports in the last 7 days." only when none arrived; reports dropped, limited or not counted are said as such. */
function emptyWindowLine(v: ReportVisibilityFields | null | undefined, days: number): string {
	return emptyReportsState(0, v) === 'none' ? `No reports in the last ${days} days.` : (emptyReportsMessage(0, v) ?? `No counted reports in the last ${days} days.`);
}

/**
 * The policy as the DNS shows it now, from the same read as the DMARC record card (one query, so the two can
 * never disagree). When DNS has no record the stored policy is only a "last known" value, and says so.
 */
function LivePolicyBadge({ domain }: { domain: Domain }) {
	const dns = useDnsCheck(domain.id);
	const onboarding = useOnboardingStatus(domain.id); // same query as the DNS records card: nxdomain and the inherited policy
	if (dns.isPending) return <Badge variant="outline">Checking DMARC policy…</Badge>;
	if (onboarding.data?.nxdomain) return <Badge variant="outline">Does not resolve</Badge>;
	const lastKnown = domain.dmarc_policy && domain.dmarc_policy !== 'none' ? ` (last known policy: p=${domain.dmarc_policy})` : '';
	if (dns.isError || dns.data.error) return <Badge variant="outline">DMARC lookup failed{lastKnown}</Badge>;
	const inherited = onboarding.data?.dmarc.effective;
	if ((!dns.data.found || !dns.data.current_record) && inherited?.inherited_from && inherited.policy) {
		// Name the tag that sets this name's policy (the parent's sp= when it has one) and its pct= below 100.
		const tag = parseDmarcSp(inherited.record ?? null) ? 'sp' : 'p';
		const pct = enforcementLevel(inherited.record ?? null).pct;
		return <Badge variant="outline">No record of its own: inherits {tag}={inherited.policy}{pct < 100 ? ` at pct=${pct}` : ''} from {inherited.inherited_from}</Badge>;
	}
	if (!dns.data.found || !dns.data.current_record) return <Badge variant="outline">No DMARC record found{lastKnown}</Badge>;
	// The shared tag parser: any letter case, spaces around `=`.
	const live = asPolicy(parseDmarcPolicy(dns.data.current_record));
	return live ? <PolicyBadge policy={live} /> : <Badge variant="outline">DMARC record has no valid p= policy</Badge>;
}

function Context({ domain, all, summary, suffixParent = null }: { domain: Domain; all: Domain[]; /** The stored summary after this page's live read. */ summary?: DomainCheckSummary; suffixParent?: string | null }) {
	const dns = useDnsCheck(domain.id);
	const parentOf = listedParentFinder(all);
	const parent = parentOf(domain) ?? undefined;
	const children = all.filter((d) => parentOf(d)?.id === domain.id);
	// The children's stored checks, as the overview reads them: a badge says only what was read.
	const childSummaries = useDomainSummaries(children.length > 0);
	if (!parent && children.length === 0) return null;
	const record = dns.data?.current_record ?? null;
	// This domain's live policy, read by the shared parser (null: no record, or no valid p=).
	const livePolicy = asPolicy(parseDmarcPolicy(record));
	const sp = spTag(record);
	const badSp = invalidDmarcSp(record);
	const ownRecord = !!dns.data && !dns.data.error && dns.data.found;
	const lookupFailed = dns.isError || !!dns.data?.error;
	// What the parent's record does for this name, in the one rule's words (sp= or p=, pct=).
	const force = summary ? policyInForce(domain.domain, summary) : null;
	const inherited = force?.kind === 'inherited' ? inForceSentence(force) : null;
	return (
		<div className="space-y-6">
			{parent ? (
				<Alert variant="info" title={ownRecord ? 'Has its own DMARC record' : lookupFailed || suffixParent || !inherited ? 'Parent domain' : 'Inherits DMARC from its parent'}>
					{ownRecord ? (
						<>
							{livePolicy ? `p=${livePolicy}` : 'Its record, which has no valid p= policy,'} overrides the parent <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>.
						</>
					) : lookupFailed ? (
						<>
							Subdomain of <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>. We could not check whether it has its own DMARC record.
						</>
					) : suffixParent ? (
						<>
							Listed under <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>. {parent.domain} is a public suffix, so its DMARC record does not apply to {domain.domain}: {domain.domain} counts as its own organization.
						</>
					) : inherited ? (
						<>
							{inherited} SPF and DKIM are independent and not inherited. <Link to={`/domains/${parent.id}`}>Open {parent.domain}</Link>
						</>
					) : (
						<>
							Subdomain of <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>. No DMARC policy reaches {domain.domain} from it.
						</>
					)}
				</Alert>
			) : null}
			{children.length > 0 ? (
				<Section
					title="Subdomains"
					actions={
						<Link className="text-sm text-brand-ink underline underline-offset-4" to="/add">
							Add subdomain
						</Link>
					}
				>
					{sp === 'reject' ? (
						<Alert variant="success" title="sp=reject">
							All subdomains without their own record are protected.
						</Alert>
					) : badSp ? (
						<Alert variant="warning" title="sp= is not a valid policy">
							{/* RFC 7489 section 6.6.3: an invalid sp= makes receivers treat the whole record as p=none (or apply no DMARC without a valid rua=). */}
							The record has sp={badSp}, which is not none, quarantine or reject, so receivers do not apply the record as written: with a valid rua= they treat it as p=none, for {domain.domain} and its subdomains; without one they ignore it. Fix sp= or remove it.
						</Alert>
					) : sp ? (
						<Alert variant="warning" title={`sp=${sp}: not enforced`}>
							Subdomains without their own DMARC record are NOT enforced. Consider adding sp=reject.
						</Alert>
					) : record && livePolicy === 'reject' ? (
						<Alert variant="success" title="No sp= tag">
							Subdomains without their own record inherit p=reject.
						</Alert>
					) : record ? (
						<Alert variant="warning" title="No sp= tag">
							{livePolicy ? `Subdomains without their own record inherit p=${livePolicy}, which may be too permissive.` : 'Subdomains without their own record inherit its p=, which is not a valid policy, so receivers ignore it.'}
						</Alert>
					) : null}
					<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1">
						{children.map((c) => (
							<li key={c.id}>
								<Link to={`/domains/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
									<span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{c.domain}</span>
									<ChildPolicyBadge summary={childSummaries.isPending ? undefined : childSummaries.isError ? null : (childSummaries.data.get(c.id) ?? null)} />
								</Link>
							</li>
						))}
					</ul>
				</Section>
			) : null}
		</div>
	);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the domain stands: the level ladder, the state, what is true now and its evidence, and setup progress. */
/** True when a stored summary fetched at `fetchedAt` (ms) can describe a live read made at `readAt` (ms; 0: none yet). */
export const summaryFetchedAfterRead = (fetchedAt: number, readAt: number): boolean => readAt === 0 || fetchedAt >= readAt;

/**
 * The stored summary against this page's live read: `fresh` once fetched after it, `waiting` while that refetch is on its
 * way, `stale` when it failed, so the last stored summary is all there is (shown, marked as possibly out of date).
 */
export function summaryFreshness(fetchedAt: number, readAt: number, q: { isFetching: boolean; isError: boolean }): 'fresh' | 'waiting' | 'stale' {
	if (summaryFetchedAfterRead(fetchedAt, readAt)) return 'fresh';
	if (q.isFetching) return 'waiting';
	return q.isError ? 'stale' : 'waiting';
}

function WhereItStands({ domain, nxdomain = false, readAt = 0, idByName, suffixParent = null, reportsRefusal }: { domain: Domain; /** The live read says the name does not exist: no setup to continue. */ nxdomain?: boolean; /** When this page's live read answered (ms): an older summary is being refetched. */ readAt?: number; idByName?: ReadonlyMap<string, number>; suffixParent?: string | null; /** Undefined while unknown (the verdict waits); null: reports can be connected. */ reportsRefusal?: ReportsRefusal | null }) {
	const summary = useCheckSummary(domain.id);
	// Hosted status still loading: no verdict yet, as on the overview (a hosted domain is never judged as self-managed).
	const { pending: hostedPending, info: hosted } = useHostedLevelInput(domain.id);
	const wizard = useWizardState(domain.id);
	const { canWrite } = useSession();
	const hostedMode = useHosted();
	const headingId = useId();
	// The same summary and 30-day totals the overview reads, so both pages say the same thing.
	// A summary fetched before the live read may predate what it stored: wait for the refetch rather than show it.
	const fresh = summaryFetchedAfterRead(summary.dataUpdatedAt, readAt) || !summary.isFetching;
	const v = summary.isError ? unavailableVerdict(errorMessage(summary.error), domain.domain) : summary.data && fresh && !hostedPending && reportsRefusal !== undefined ? domainVerdict(domain, summary.data, totalsFromSummary(summary.data), hosted, undefined, { hostedMode, idByName, suffixParent, reportsRefusal }) : null;
	const progress = canWrite && wizard.data ? wizardProgress(wizard.data, { hosted: hostedMode }) : null;
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="text-lg font-semibold tracking-tight">
				Where it stands
			</h2>
			<div className="grid gap-x-6 gap-y-4 rounded-lg border border-line bg-surface-1 p-4 sm:p-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
				{v ? <LevelLadder level={v.level} className="self-start lg:pt-1" /> : <Skeleton className="h-8 w-full" />}
				<div className="min-w-0 space-y-1.5">
					{v ? (
						<>
							<StatusLabel kind={v.status} />
							<p className="max-w-prose text-sm text-ink-1">{v.sentence}</p>
							{v.evidence ? <p className="max-w-prose text-sm text-ink-2">{v.evidence}</p> : null}
							{v.checked ? <p className="text-xs text-ink-2">{v.checked}</p> : null}
							{summary.isError ? (
								<Button variant="secondary" size="sm" onClick={() => void summary.refetch()}>
									Try again
								</Button>
							) : null}
						</>
					) : (
						<p className="text-sm text-ink-2">Loading what is known about this domain…</p>
					)}
					{/* Only while DNS shows the domain is not yet enforcing: an enforced domain's setup is done, whatever the wizard recorded. */}
					{!nxdomain && progress && progress.done < progress.total && v && (v.level === 0 || v.level === 1) ? (
						<p className="pt-1 text-sm text-ink-2">
							Setup wizard: {progress.done} of {progress.total} steps done.{' '}
							<Link to={`/domains/${domain.id}/setup/${progress.nextStep}`} className="font-medium text-brand-ink underline underline-offset-4">
								Continue setup
							</Link>
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

function DomainDetail({ domain, all }: { domain: Domain; all: Domain[] }) {
	const qc = useQueryClient();
	const [days, setDays] = useState<number>(7);
	const stats = useStats(domain.id, days);
	const week = useStats(domain.id, 7);
	const sources = useFailingSources(domain.id);
	const dns = useDnsCheck(domain.id);
	const onboarding = useOnboardingStatus(domain.id);
	const summary = useCheckSummary(domain.id);
	const rollout = useRolloutNext(domain.id);
	// The health report runs live DNS and reads collected evidence: only when its section is opened.
	const [healthOpen, setHealthOpen] = useState(false);
	const health = useHealthReport(domain.id, healthOpen);
	const spfTool = useSpfFlatten(domain.id);
	const mtaTool = useMtaSts(domain.id);
	const { canWrite } = useSession();
	// Hosted, before report intake: no reports can arrive (see ReportsNotConnected).
	const reportsOff = useReportsNotConnected(domain);
	const nxdomain = !!onboarding.data?.nxdomain;
	// Hosted: the self-host reporting-address block never applies (the reports panel shows the address).
	const hostedMode = useHosted();

	// Reading DNS here also stores what it found (the overview's "checked when"), so refresh the stored summary after it.
	const readAt = onboarding.dataUpdatedAt;
	useEffect(() => {
		if (readAt) void qc.invalidateQueries({ queryKey: domainKeys.summary(domain.id) });
	}, [readAt, qc, domain.id]);

	const totals = (q: typeof week, n: number): ReportTotals | null | undefined => {
		if (q.isPending) return undefined;
		if (q.isError) return null;
		const s = sumStats(q.data.stats);
		return { total: s.total, passed: s.passed, failed: s.failed, passRate: s.passRate, days: n };
	};
	const week7 = totals(week, 7);
	const { pending: hostedPending, info: hostedInfo } = useHostedLevelInput(domain.id);
	// The same nearest listed ancestor the overview uses.
	const parentOf = listedParentFinder(all);
	const parent = parentOf(domain) ?? undefined;
	const parentSummary = useCheckSummary(parent?.id ?? 0, !!parent);
	// The stored summary counts only once it was fetched after this page's live read (compare fetch times). If that refetch
	// failed, the last stored summary is used, marked as possibly out of date, with a retry: never "Reading…" forever.
	const freshness = summaryFreshness(summary.dataUpdatedAt, onboarding.isSuccess ? onboarding.dataUpdatedAt : 0, summary);
	const summaryStale = freshness === 'stale' && !!summary.data;
	// While the hosted status loads, nothing is judged from the summary (a hosted domain is not self-managed).
	// Whether reports can be connected here (hosted plans may not offer it): asked only for a domain without them.
	// Why reports cannot be connected for this domain, from the same per-domain answer the overview reads.
	const { pending: refusalPending, refusal: reportsRefusal } = useReportsRefusal(domain.id);
	const summaryFresh = freshness !== 'waiting' && !hostedPending && !refusalPending;
	// A listed parent whose own record does not cover this name: a public suffix (gov.uk above www.gov.uk).
	const suffixParent = summaryFresh && parent ? suffixParentOf(summary.data, { domain: parent.domain, summary: parentSummary.data }) : null;
	const actionInput = {
		domain,
		dns: dns.isPending ? undefined : dns.isError ? null : dns.data,
		onboarding: onboarding.isPending ? undefined : onboarding.isError ? null : onboarding.data,
		summary: summary.data ?? (summary.isError ? null : undefined),
		sources: sources.data ?? null,
		// A fix to an inherited policy belongs on the parent: link to it when it is in this workspace (as the overview does).
		parentId: all.find((d) => d.domain === summary.data?.dmarc_inherited_from)?.id,
		summaryFresh,
		hosted: hostedInfo,
		suffixParent,
		reportsRefusal,
	};
	const actions = domainActions(actionInput);

	const sums = stats.data ? sumStats(stats.data.stats) : null;
	// The DMARC step for the Reports section: the shared rule's, the same "Do this next" leads with, never a verdict of its own.
	const governing = onboarding.data?.dmarc.effective?.inherited_from ? (onboarding.data.dmarc.effective.record ?? null) : null;
	const dmarcStep = summary.data && summaryFresh && !(dns.isError || dns.data?.error) ? dmarcStepsFor(domain, summary.data, totalsFromSummary(summary.data), hostedInfo, suffixParent, governing ? recordAlignment(governing) : null, reportsRefusal)[0] : undefined;
	// Nothing counted in the window, and nothing arrived: only then may the DNS state say reports are on their way.
	const noneArrived = !!sums && sums.total === 0 && emptyReportsState(0, stats.data) === 'none';

	const children = all.filter((d) => parentOf(d)?.id === domain.id);
	const selectors = onboarding.data?.dkim.selectors.length;
	const enforcing = rollout.data && (rollout.data.current_policy === 'quarantine' || rollout.data.current_policy === 'reject');
	const toolsShown = !(spfTool.isSuccess && !spfTool.data.available && !spfTool.data.config && mtaTool.isSuccess && !mtaTool.data.available && !mtaTool.data.config);
	const failing = sources.data?.length ?? 0;

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={
					<Link to="/" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						All domains
					</Link>
				}
				title={domain.domain}
				description={<LivePolicyBadge domain={domain} />}
				actions={
					<div className="flex flex-wrap gap-2">
						<Button asChild variant="secondary">
							<Link to={`/domains/${domain.id}/analytics`}>
								<BarChart3 aria-hidden />
								Analytics
							</Link>
						</Button>
						<Button asChild variant="secondary">
							<Link to={`/domains/${domain.id}/settings`}>
								<Settings aria-hidden />
								Settings
							</Link>
						</Button>
					</div>
				}
			/>
			<ReadOnlyNotice />
			<DoThisNext
				actions={actions}
				pending={actionsPending(actionInput)}
				stale={summaryStale}
				onReloadSummary={() => void summary.refetch()}
				canWrite={canWrite}
				onRetry={() => void Promise.all([dns.refetch(), onboarding.refetch()])}
			/>
			<WhereItStands domain={domain} nxdomain={nxdomain} readAt={onboarding.isSuccess ? onboarding.dataUpdatedAt : 0} idByName={new Map(all.map((d) => [d.domain, d.id]))} suffixParent={suffixParent} reportsRefusal={refusalPending ? undefined : reportsRefusal} />

			{/* A name that does not resolve has nothing to host. */}
			{nxdomain ? null : <HostedPanel key={domain.id} domainId={domain.id} />}
			{/* Hosted with report intake, once connected: connected → published → received. Before that, ReportsNotConnected
			    carries the Connect reports action. Renders nothing elsewhere. */}
			{reportsOff || nxdomain ? null : <ConnectReports domain={domain} />}

			<div className="space-y-3">
				<Disclosure
					id="dns-records"
					title="DNS records"
					summary={`DMARC, SPF${selectors === undefined ? ' and DKIM' : onboarding.data?.dkim.wildcard ? ', and DKIM that public DNS can\'t show (wildcard)' : selectors === 0 ? ', and no DKIM key among the common selectors' : ` and ${plural(selectors, 'DKIM key')}`}, read live from public DNS.`}
				>
					<DnsRecords domain={domain} />
				</Disclosure>

				{/* Hosted, before report intake: no reports can arrive, so the report sections say so once instead of showing zeros. */}
				{reportsOff ? (
					<ReportsNotConnected domain={domain.domain} domainId={domain.id} />
				) : (
				<Disclosure
						title="Reports"
						summary={
							week.isPending
								? 'Loading report totals…'
								: week.isError
									? 'Report totals could not be loaded.'
									: week7 && week7.total > 0
										? `${week7.passRate}% of ${formatNumber(week7.total)} reported messages passed DMARC in the last 7 days.`
										: emptyWindowLine(week.data, 7)
						}
					>
						<div className="space-y-6">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<p className="text-sm text-ink-1">
									{stats.isPending
										? 'Loading…'
										: stats.isError
											? null
											: sums && sums.total > 0
												? `Last ${days} days: ${sums.passRate}% passed. ${formatNumber(sums.passed)} of ${formatNumber(sums.total)} messages passed, ${formatNumber(sums.failed)} failed.`
												: emptyWindowLine(stats.data, days)}
								</p>
								<Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
									<TabsList aria-label="Time window">
										{WINDOWS.map((w) => (
											<TabsTrigger key={w} value={String(w)}>
												{w}d<span className="sr-only"> window</span>
											</TabsTrigger>
										))}
									</TabsList>
								</Tabs>
							</div>
							{stats.isError ? <LoadError error={stats.error} onRetry={() => void stats.refetch()} title="Could not load results" /> : null}
							{dmarcStep ? (
								// The shared rule's "done" is about DMARC only: "Do this next" above judges the whole domain.
								<Alert variant={STEP_ALERT[dmarcStep.status]} title={dmarcStep.key === 'done' ? 'DMARC needs no change' : dmarcStep.do}>
									<p>{dmarcStep.why}</p>
									{dmarcStep.where === 'dmarc-wizard' && canWrite ? (
										<Button asChild size="sm" variant="secondary" className="mt-3">
											<Link to={`/domains/${domain.id}/dmarc-wizard`}>Review the change</Link>
										</Button>
									) : null}
								</Alert>
							) : null}
							{/* Nothing arrived in the window: what DNS shows about whether reports can arrive. */}
							{noneArrived && dns.data ? (
								<p className="text-sm text-ink-1">
									{dns.data.error
										? 'We could not check your DNS record just now. See DNS records above.'
										: dns.data.found && dmarcRecordProblem(dns.data.current_record, `_dmarc.${domain.domain}`, summary.data?.dmarc_inherited_from ? null : summary.data?.dmarc_issue)
											? 'The DMARC record is not applied as published, so reports may not arrive. See DNS records above.'
										: dns.data.found && dns.data.has_rua
											? 'DNS record detected. Reports will start arriving soon.'
											: dns.data.found
												? hasReportAddress(domain.rua_address)
													? 'A DMARC record is published, but it does not send reports to your reports address yet. See DNS records above.'
													: 'A DMARC record is published. No reports address is configured for this domain, so no reports can arrive here yet.'
												: 'DNS record not found yet. Make sure you have added it, then wait a few minutes for propagation.'}
								</p>
							) : null}
							{stats.isPending ? <ListSkeleton rows={1} label="Loading daily results" /> : stats.isError ? null : <DailyChart domainId={domain.id} stats={stats.data.stats} days={days} visibility={stats.data} />}
							{hostedMode ? null : (
							<div className="space-y-2">
								<p className="text-sm font-semibold text-ink-1">Reporting address</p>
								{hasReportAddress(domain.rua_address) ? (
									<>
										<p className="text-sm text-ink-2">
											Add this to your <code>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.
										</p>
										<CopyField label="RUA" value={`rua=mailto:${domain.rua_address.trim()}`} />
									</>
								) : (
									<p className="text-sm text-ink-2">No reports address is configured for this domain, so there is no rua= value to add yet.</p>
								)}
							</div>
							)}
							<Link className="inline-block text-sm text-brand-ink underline underline-offset-4" to={`/domains/${domain.id}/reports`}>
								All reports
							</Link>
						</div>
					</Disclosure>
				)}

				{!reportsOff && (failing > 0 || sources.isError) ? (
					<Disclosure title="Failing senders" summary={sources.isError ? 'Could not be loaded.' : `${plural(failing, 'source')} sent mail that failed DMARC in the last 7 days.`}>
						<FailingSources domainId={domain.id} q={sources} />
					</Disclosure>
				) : null}

				{enforcing || rollout.isError ? (
					<Disclosure
						title="Rollout"
						summary={rollout.data && enforcing ? `Step ${rollout.data.current_step_index + 1} of ${rollout.data.total_steps}, at p=${rollout.data.current_policy}.${rollout.data.next_step ? '' : hasReportAddress(domain.rua_address) ? ' Fully graduated.' : ' The last step; reports are not connected, so the senders are not confirmed.'}` : 'Could not be loaded.'}
					>
						<Rollout domain={domain} />
					</Disclosure>
				) : null}

				{parent || children.length > 0 ? (
					<Disclosure title={parent ? 'Parent domain' : 'Subdomains'} summary={parent ? `Subdomain of ${parent.domain}.` : `${plural(children.length, 'subdomain')} monitored.`}>
						<Context domain={domain} all={all} summary={summaryFresh ? summary.data : undefined} suffixParent={suffixParent} />
					</Disclosure>
				) : null}

				{/* A name DNS says does not exist has no records to report on: the DNS records section says so once. */}
				{nxdomain ? null : (
				<Disclosure
					onOpenChange={(o) => o && setHealthOpen(true)}
					title="Email health report"
					summary={
						!healthOpen
							? 'Live DNS findings and proposed fixes, checked when you open this: the same evidence your authorized agent sees.'
							: health.isPending
							? 'Checking live DNS and collected evidence…'
							: health.isError
								? 'Could not be loaded.'
								: `${plural(health.data.dns.findings.length, 'finding')} and ${plural(health.data.remediation.length, 'proposed fix', 'proposed fixes')}: the same evidence your authorized agent sees.`
					}
				>
					<HealthReportSection domainId={domain.id} enabled={healthOpen} />
				</Disclosure>
				)}

				{toolsShown ? (
					<Disclosure title="DNS tools" summary="Optional tools that change your DNS for you: SPF flattening and MTA-STS.">
						<DnsTools domainId={domain.id} />
					</Disclosure>
				) : null}
			</div>
		</div>
	);
}

export function DomainDetailPage() {
	const id = useDomainId();
	const list = useDomains();
	const { domain } = useDomain(id);
	// A domain added in another tab or by an agent is not in a cached list yet: refetch once before saying "not found".
	const [refetched, setRefetched] = useState(false);
	const asked = useRef(false);
	const missing = !list.isPending && !list.isError && !domain;
	const { refetch } = list;
	useEffect(() => {
		if (!missing || asked.current) return;
		asked.current = true;
		void refetch().finally(() => setRefetched(true));
	}, [missing, refetch]);
	if (list.isPending || (missing && !refetched)) return <PageSkeleton label="Loading domain" />;
	if (list.isError) return <LoadError error={list.error} onRetry={() => void list.refetch()} title="Could not load this domain" />;
	if (!domain) {
		return (
			<EmptyState
				title="Domain not found"
				description="It may have been removed, or the link is wrong."
				action={
					<Button asChild>
						<Link to="/">Back to all domains</Link>
					</Button>
				}
			/>
		);
	}
	return <DomainDetail domain={domain} all={list.data} />;
}
