import { Alert, Button, RecordBlock, StatusDot, type StatusDotStatus } from '@ready-set-mail/ui';
import { RefreshCw } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError, errorMessage } from '../../lib/api';
import { countingBasisNote, emptyReportsState, storageDropNotices, uncountedNotice, uncountedReporters } from '../../lib/uncounted';
import { formatDateTime, timeAgo } from '../../lib/format';
import {
	useReportAddress,
	useCheckReportsAgain,
	useReportAddressMutations,
	useReportIntakeEnabled,
	type OwnPlan,
	type ReportAddressPlan,
	type ReportAddressState,
	type ReportAddressView,
	type ReportChoice,
	type ReportRecordReview,
} from '../../lib/report-address';
import { ruaLimitSentence } from '@ready-set-mail/dns-checks/dmarc-rua';
import { hostOf, isCloudflareHost, useDnsHost } from '../../lib/dns-host';
import { ConnectCloudflareLink } from '../ConnectCloudflareLink';
import { CopyField } from '../domain/CopyField';
import { Change } from '../domain/RecordChange';
import { DnsHostLine } from '../domain/DnsHostLine';
import { ConfirmDialog } from '../domain/ConfirmDialog';
import { RadioCard } from '../wizard/RadioCard';
import { inheritedCoverage, keptEnforcement, offerEnforcement, offeredDmarcRecord } from '../../lib/dmarc-coverage';
import { parseDmarcTags } from '../../lib/dmarc-record';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';

/**
 * Hosted only: connect a domain's DMARC reports. One action connects the domain to the hosted report address, then the
 * panel shows exactly what to publish (the live DMARC record with the address added, never a weaker policy) and how far
 * it has got from live DNS and stored reports: connected, published, receiving. Renders nothing, and requests nothing, unless this deployment takes hosted reports
 * (GET /api/hosted/config `reports: true`), so self-hosted instances are unchanged.
 *
 * Integration: `<ConnectReports domain={domain} />` anywhere a domain is known (`{ id, domain }`). `bare` is for a
 * container that already says reports are not connected (ReportsNotConnected): no section heading, and before reports
 * are connected only the action itself. `headless` drops only the section heading (a wizard step that has its own).
 */
export function ConnectReports({ domain, bare = false, headless = false }: { domain: { id: number; domain: string }; bare?: boolean; headless?: boolean }) {
	const enabled = useReportIntakeEnabled();
	if (!enabled) return null;
	const body = <Panel domainId={domain.id} domainName={domain.domain} bare={bare} />;
	return bare || headless ? (
		<div data-testid="connect-reports">{body}</div>
	) : (
		<div data-testid="connect-reports">
			<Section title="DMARC reports">{body}</Section>
		</div>
	);
}

const STATE_DOT: Record<ReportAddressState, { status: StatusDotStatus; label: string }> = {
	not_connected: { status: 'unknown', label: 'Reports not connected yet' },
	not_published: { status: 'warn', label: 'Connected, record not published yet' },
	written: { status: 'info', label: 'Written to Cloudflare, not in public DNS yet' },
	waiting: { status: 'info', label: 'Published, waiting for the first report' },
	receiving: { status: 'ok', label: 'Reports received' },
	unknown: { status: 'unknown', label: 'Connected, DNS check failed' },
};

/** What Apply can still do for a review: write or only connect, or a choice among the first two addresses. Never a blocked review. */
const applyable = (review: ReportRecordReview | null | undefined): review is ReportRecordReview => !!review && review.outcome.kind !== 'blocked';

/** The record changed between the review and Apply: the server answers 409 with the fresh review (src/hosted/report-address-routes.ts). */
function changedReview(error: unknown): ReportRecordReview | null {
	if (!(error instanceof ApiError) || error.status !== 409) return null;
	const body = error.body as { code?: string; review?: ReportRecordReview } | undefined;
	return body?.code === 'record_changed' && body.review ? body.review : null;
}

function Panel({ domainId, domainName, bare }: { domainId: number; domainName: string; bare: boolean }) {
	const q = useReportAddress(domainId);
	const m = useReportAddressMutations(domainId);
	const checkAgain = useCheckReportsAgain(domainId);
	const [disconnectOpen, setDisconnectOpen] = useState(false);
	const [reviewing, setReviewing] = useState(false);

	if (q.isPending) return <ListSkeleton rows={1} label="Loading the report address" />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the report address" />;
	const s = q.data;
	if (!s.available) return null;

	if (s.managed_by === 'hosted_records') {
		return <p className="text-sm text-ink-2">Reports for {domainName} come through its hosted records.</p>;
	}

	// The error comes first: at 375 wide it must be in the first screen, not below a long record.
	const changed = changedReview(m.apply.error);
	const applyFailed = m.apply.isError && !changed ? (
		<Alert variant="danger" title="Could not write the record">
			{errorMessage(m.apply.error)}
		</Alert>
	) : null;
	// The review on screen: the fresh one a 409 carried, else the status's own.
	const review = changed ?? s.review ?? null;
	const onApply = (choice: ReportChoice) => review && m.apply.mutate({ reviewed: review.hash, choice });

	if (!s.address) {
		// Cloudflare reaches the zone and the live record can take our address: review the change, then one Apply connects and writes.
		const open = s.can_connect && s.apply_via_cloudflare && applyable(s.review);
		if (open && (reviewing || changed)) {
			return (
				<div className="space-y-3 rounded-lg border border-line bg-surface-1 p-4" data-state="review">
					{applyFailed}
					<ReviewRecord review={review!} changed={!!changed} pending={m.apply.isPending} onApply={onApply} onCancel={() => { setReviewing(false); m.apply.reset(); }} />
				</div>
			);
		}
		return (
			<div className={bare ? 'space-y-3' : 'space-y-3 rounded-lg border border-line bg-surface-1 p-4'} data-state="not_connected">
				{bare ? null : (
					<>
						<StatusDot status={STATE_DOT.not_connected.status} label={STATE_DOT.not_connected.label} className="font-semibold" />
						<p className="text-sm text-ink-2">
							A report address is where a domain&apos;s DMARC record sends its reports: mail services tell you which servers sent mail as <Mono>{domainName}</Mono> and whether it
							passed. <Mono>{domainName}</Mono> has no Ready Set Mail report address yet.
						</p>
						<ReportsMore />
					</>
				)}
				{s.can_connect ? (
					<WriteButton onClick={() => (open ? setReviewing(true) : m.connect.mutate())} disabled={m.connect.isPending} reasonVisible>
						{m.connect.isPending ? 'Connecting…' : 'Connect reports'}
					</WriteButton>
				) : (
					<p className="text-sm text-ink-2">{s.refusal}</p>
				)}
				{s.can_connect && s.apply_via_cloudflare && s.review?.outcome.kind === 'blocked' ? <p className="text-sm text-ink-2">{s.review.outcome.reason}</p> : null}
				{m.connect.isError ? (
					<Alert variant="danger" title="Could not connect reports">
						{errorMessage(m.connect.error)}
					</Alert>
				) : null}
			</div>
		);
	}

	const disconnectErr = m.disconnect.isError ? errorMessage(m.disconnect.error) : null;
	const livePlan = s.dns?.plan ?? null;
	// Apply is offered while the record in the zone does not list the address yet; once it does (written), only public DNS is being waited for.
	const canApply = s.apply_via_cloudflare === true && applyable(review) && s.state !== 'written' && s.state !== 'waiting' && s.state !== 'receiving';
	return (
		<div className="space-y-4 rounded-lg border border-line bg-surface-1 p-4" data-state={s.state}>
			{applyFailed}
			{m.apply.isSuccess && m.apply.data.wrote ? <p className="text-sm font-medium text-ink-1">Report address added.</p> : null}
			<StateLine
				s={s}
				applying={canApply}
				// Next to the status it refreshes, so it is in the first screen at 375 wide (the record to publish is long).
				action={
					<Button variant="secondary" size="sm" onClick={checkAgain} disabled={q.isFetching}>
						<RefreshCw aria-hidden />
						{q.isFetching ? 'Checking…' : 'Check again'}
					</Button>
				}
			/>
			<CopyField label="Report address" value={s.address} />
			{canApply ? (
				<ReviewRecord review={review!} changed={!!changed} pending={m.apply.isPending} onApply={onApply} />
			) : s.dns?.plan && s.state !== 'written' ? (
				<>
					{s.state === 'not_published' && livePlan && (livePlan.kind === 'add' || livePlan.kind === 'choose') ? <PublishElsewhere domain={domainName} /> : null}
					<PlanView plan={s.dns.plan} domain={domainName} parent={s.parent ?? null} address={s.address} />
				</>
			) : null}
			<div className="flex flex-wrap gap-2">
				<WriteButton variant="danger" size="sm" onClick={() => setDisconnectOpen(true)}>
					Disconnect reports
				</WriteButton>
			</div>
			<ConfirmDialog
				open={disconnectOpen}
				onOpenChange={(o) => {
					setDisconnectOpen(o);
					if (!o) m.disconnect.reset();
				}}
				title={`Disconnect reports for ${domainName}?`}
				description={`From now on, reports about ${domainName} are refused. Reports already received stay. Remove the address from your DMARC record too.`}
				confirmLabel="Disconnect reports"
				busyLabel="Disconnecting…"
				variant="danger"
				busy={m.disconnect.isPending}
				error={disconnectErr}
				onConfirm={() => m.disconnect.mutate(undefined, { onSuccess: () => setDisconnectOpen(false) })}
			/>
		</div>
	);
}

/** What a DMARC report address is, in RFC 7489's terms (6.3: the rua= tag and ri=, whose default is 86400 seconds; 7.2: aggregate reports). */
function ReportsMore() {
	return (
		<details className="text-sm text-ink-2">
			<summary className="cursor-pointer rounded-sm font-medium text-brand-ink underline underline-offset-4">More</summary>
			<div className="mt-2 space-y-2">
				<p>
					Mail services that receive mail claiming to be from your domain, for example large mailbox providers, send aggregate reports to the addresses in the rua= tag of your
					DMARC record. It is usually once a day: the record&apos;s ri= interval defaults to 86400 seconds.
				</p>
				<p>Each report counts messages by sending IP address, with their SPF and DKIM results and what the receiver did with them. Reports contain no message content. Source: RFC 7489.</p>
			</div>
		</details>
	);
}

/** The record to publish by hand: where this domain's DNS is hosted, and Cloudflare when that is where it is. */
function PublishElsewhere({ domain }: { domain: string }) {
	const host = useDnsHost(domain);
	const cloudflare = isCloudflareHost(hostOf(host.data));
	return (
		<>
			<DnsHostLine domain={domain} />
			{cloudflare ? <ConnectCloudflareLink>Connect Cloudflare to write this for you</ConnectCloudflareLink> : null}
		</>
	);
}

const LEAVE = '__leave__';

/**
 * The review of the one write of our address (POST /api/domains/:id/report-address/apply): the record in the zone now, and what it becomes
 * after Apply. Every record shown was built by the server from the live record; Apply sends the review's hash and the choice, never a record.
 * Two addresses or more: the person picks which of the first two ours replaces, or leaves the record as it is (reports then stay not connected).
 * `changed`: the record moved since the person looked, so this is the fresh review.
 */
function ReviewRecord({ review, changed, pending, onApply, onCancel }: { review: ReportRecordReview; changed: boolean; pending: boolean; onApply: (choice: ReportChoice) => void; onCancel?: () => void }) {
	const o = review.outcome;
	const [choice, setChoice] = useState<string | null>(null);
	const name = useId();
	const legend = useId();
	const heading = changed ? 'The record changed since you looked: here it is now' : `Review the change to ${review.name}`;
	if (o.kind === 'blocked') return <p className="text-sm text-ink-2">{o.reason}</p>;
	const picked = o.kind === 'choose' && choice !== null && choice !== LEAVE ? o.options.find((x) => x.replaces === choice) ?? null : null;
	const after = o.kind === 'write' ? o.after : picked?.after ?? null;
	const reason =
		o.kind === 'write' && o.action === 'update'
			? 'Only rua= changes: the policy and every other tag stay as they are, and the report addresses already there are kept.'
			: o.kind === 'write'
				? review.inherited
					? `${o.reason} Its reports go only to the report address.`
					: 'p=none asks receivers for reports and changes nothing about how they handle your mail.'
				: 'Only rua= changes: the policy and every other tag stay as they are. The address you chose to replace stops getting reports from this record.';
	const canApply = o.kind === 'write' || o.kind === 'present' || picked !== null;
	return (
		<div className="space-y-3">
			<h3 className="text-sm font-semibold text-ink-1">{heading}</h3>
			{review.inherited ? (
				<p className="text-sm text-ink-2">
					<Mono>{review.name.replace(/^_dmarc\./, '')}</Mono> has no DMARC record of its own: it follows the record of <Mono>{review.inherited.from}</Mono> (<Mono>{review.inherited.record}</Mono>).
				</p>
			) : null}
			{o.kind === 'choose' ? (
				<fieldset className="space-y-2" aria-labelledby={legend}>
					<p id={legend} className="text-sm text-ink-2">
						{ruaLimitSentence(o.existing.length)} Nothing changes until you press Apply.
					</p>
					<p className="text-sm text-ink-2">
						Now: <Mono>{review.now ?? ''}</Mono>
					</p>
					{o.options.map((x) => (
						<RadioCard
							key={x.replaces}
							name={name}
							value={x.replaces}
							checked={choice === x.replaces}
							onChange={setChoice}
							title={<span className="[overflow-wrap:anywhere]">Replace {x.replaces}</span>}
						>
							That address stops getting reports from this record.
						</RadioCard>
					))}
					<RadioCard name={name} value={LEAVE} checked={choice === LEAVE} onChange={setChoice} title="Leave the record as it is">
						Nothing is written and reports stay not connected.
					</RadioCard>
				</fieldset>
			) : null}
			{after ? (
				<ul aria-label="Change">
					<Change w={{ id: 'dmarc', type: 'TXT', name: review.name, action: review.now ? 'update' : 'create', before: review.now, content: after, reason }} />
				</ul>
			) : o.kind === 'present' ? (
				<p className="text-sm text-ink-2">The record in your Cloudflare zone already lists the report address, so nothing is written: Apply connects the reports.</p>
			) : choice === LEAVE ? (
				<p className="text-sm text-ink-2">The record stays as it is and reports stay not connected. Choose an address to replace whenever you want them.</p>
			) : (
				<p className="text-sm text-ink-2">Choose an option to see the record Apply writes.</p>
			)}
			{choice === LEAVE ? null : (
				<p className="text-sm text-ink-2">{o.kind === 'present' ? 'Apply connects the reports.' : 'Apply connects the reports and writes it in your Cloudflare zone.'}</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{choice === LEAVE ? null : (
					<WriteButton onClick={() => onApply(o.kind === 'choose' ? { kind: 'replace', address: picked!.replaces } : { kind: 'add' })} disabled={!canApply || pending} reasonVisible>
						{pending ? 'Applying…' : 'Apply'}
					</WriteButton>
				)}
				{onCancel ? (
					<Button variant="ghost" onClick={onCancel} disabled={pending}>
						Cancel
					</Button>
				) : null}
			</div>
		</div>
	);
}

function StateLine({ s, applying = false, action }: { s: ReportAddressView; /** Apply (below) writes the record: no "publish" instruction. */ applying?: boolean; action?: ReactNode }) {
	const dot = STATE_DOT[s.state];
	let detail: ReactNode = null;
	if (s.state === 'written') {
		detail = <>Written to Cloudflare; public DNS can take a few minutes to show it.</>;
	} else if (s.state === 'not_published') {
		detail = (
			<>
				Checked in live DNS {s.dns ? timeAgo(s.dns.checked_at) : 'just now'}: the DMARC record does not list the report address yet.{' '}
				{applying ? 'Review the change below and press Apply.' : 'Publish the record below.'}
			</>
		);
	} else if (s.state === 'waiting') {
		detail = <>Your DMARC record lists the report address. Receivers send reports about once a day, so the first one can take a day or two.</>;
	} else if (s.state === 'receiving' && s.last_report_at) {
		detail = (
			<>
				Last counted report received {formatDateTime(s.last_report_at)} ({timeAgo(s.last_report_at)}). <Link to={`/domains/${s.domain_id}/reports`}>Open the reports</Link>
			</>
		);
	} else if (s.state === 'unknown') {
		detail = <>We could not read the DMARC record just now, so we cannot say whether it lists the report address. The lookup failed; that does not mean the record is missing.</>;
	}
	const plural = (n: number) => (n === 1 ? '1 report' : `${n} reports`);
	// What else is true about the reports since connecting, in the dashboard's shared words (web/src/lib/uncounted.ts): reports from
	// senders we do not recognise are not counted, counted reports dropped for want of storage, and mail that could not be processed.
	const v = s.visibility ?? null;
	const empty = s.state === 'receiving' ? 'counted' : emptyReportsState(s.counted_since_connect, v);
	const notes = [
		...storageDropNotices(v),
		uncountedNotice(v),
		uncountedReporters(v),
		empty === 'not_processed' || empty === 'limited' ? v?.intake?.notice ?? null : null,
		empty === 'blocked' ? v?.counting_note ?? null : null,
	].filter((x): x is string => !!x);
	const basis = countingBasisNote(v?.report_counting);
	return (
		<div className="space-y-1">
			<StatusDot status={dot.status} label={dot.label} className="font-semibold" />
			{detail ? <p className="text-sm text-ink-2">{detail}</p> : null}
			{action ? <div className="pt-1">{action}</div> : null}
			{notes.map((n) => (
				<p key={n} className="text-sm text-ink-2" data-testid="reports-notice">
					{n}
				</p>
			))}
			{s.reports_before_connect > 0 ? <p className="text-sm text-ink-2">{plural(s.reports_before_connect)} received before this connection.</p> : null}
			{basis && s.state !== 'not_connected' ? <p className="text-xs text-ink-2">{basis}</p> : null}
		</div>
	);
}

const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">{children}</code>;

function PlanView({ plan, domain, parent, address }: { plan: ReportAddressPlan; domain: string; parent: ReportAddressView['parent']; address: string }) {
	if (plan.kind === 'published') return null;
	if (plan.kind === 'multiple') {
		return (
			<Alert variant="warning" title={`${plan.name} has ${plan.records.length} DMARC records`}>
				<p>Receivers ignore all of them when there is more than one. Keep one, then add the report address to its rua= tag.</p>
				<ul className="mt-2 space-y-1">
					{plan.records.map((r) => (
						<li key={r}>
							<Mono>{r}</Mono>
						</li>
					))}
				</ul>
			</Alert>
		);
	}
	if (plan.kind === 'invalid') {
		return (
			<Alert variant="warning" title={`The DMARC record at ${plan.name} is not valid`}>
				<p>
					{plan.issues.join('. ')}. Receivers apply no policy from it. Fix it first, then check again to see the record to publish.
				</p>
				<p className="mt-2">
					<Mono>{plan.record}</Mono>
				</p>
			</Alert>
		);
	}
	if (plan.kind === 'inherited') {
		const parentLink = parent ? <Link to={`/domains/${parent.domain_id}`}>{plan.from}</Link> : <>{plan.from}</>;
		return (
			<div className="space-y-3">
				<p className="text-sm text-ink-2">
					<Mono>{domain}</Mono> has no DMARC record of its own. It follows the record of <Mono>{plan.from}</Mono>, where{' '}
					{plan.policy_tag === 'sp' ? <>sp={plan.policy} applies to its subdomains</> : <>p={plan.policy} applies to it and its subdomains</>}, and receivers send its reports to
					the addresses listed there.
				</p>
				<p className="text-sm text-ink-2" data-testid="inherited-route">
					{plan.parent_has_address ? (
						parent?.connected ? (
							<>{parentLink}&apos;s record lists the report address and {plan.from} is connected here, so reports about {domain} are filed with {plan.from}&apos;s reports.</>
						) : parent ? (
							<>{parentLink}&apos;s record lists the report address, but {plan.from} is not connected in this workspace, so those reports are refused. Connect reports on {parentLink} to receive them, including those about {domain}.</>
						) : (
							<>{plan.from}&apos;s record lists the report address, but {plan.from} is not in this workspace, so its reports, including those about {domain}, are not filed here. Add {plan.from} to this workspace and connect reports there to receive them.</>
						)
					) : parent?.connected ? (
						<>{parentLink} is connected here, so once its record lists the report address, reports about {domain} arrive with its reports.</>
					) : parent ? (
						<>To keep following {plan.from}, connect reports on {parentLink} instead. Reports about {domain} then arrive with its reports.</>
					) : (
						<>To keep following {plan.from}, add {plan.from} to this workspace and connect reports there instead. Reports about {domain} then arrive with its reports.</>
					)}
				</p>
				<InheritedOwnRecord plan={plan} domain={domain} address={address} />
			</div>
		);
	}
	return <OwnPlanView plan={plan} domain={domain} />;
}

function Current({ record }: { record: string }) {
	return (
		<p className="text-sm text-ink-2">
			Published now: <Mono>{record}</Mono>
		</p>
	);
}

function OwnPlanView({ plan, domain, inherited = false }: { plan: OwnPlan; domain: string; inherited?: boolean }) {
	if (plan.kind === 'published') return null;
	if (plan.kind === 'add') {
		return (
			<div className="space-y-2">
				{plan.current ? <Current record={plan.current} /> : null}
				<RecordToPublish replace={!!plan.current} name={plan.name} value={plan.record} />
				<p className="text-sm text-ink-2">
					{plan.current
						? 'Only rua= changes: the policy and every other tag stay as they are.'
						: inherited
							? 'Every tag and the policy stay as they apply today; only the rua= list gains this address.'
							: `${domain} has no DMARC record. p=none asks receivers for reports and changes nothing about how they handle your mail.`}
				</p>
			</div>
		);
	}
	return <ChooseView plan={plan} />;
}

function ChooseView({ plan }: { plan: Extract<OwnPlan, { kind: 'choose' }> }) {
	const [choice, setChoice] = useState<string | null>(null);
	const name = useId();
	const legend = useId();
	const picked = choice === null ? null : plan.options.find((o) => o.replaces === choice) ?? null;
	return (
		<div className="space-y-3">
			{plan.current ? <Current record={plan.current} /> : null}
			<fieldset className="space-y-2" aria-labelledby={legend}>
				<p id={legend} className="text-sm text-ink-2">
					{ruaLimitSentence(plan.existing.length)} Nothing changes until you publish the record.
				</p>
				{plan.options.map((o) => (
					<RadioCard key={o.replaces} name={name} value={o.replaces} checked={choice === o.replaces} onChange={setChoice} title={<span className="[overflow-wrap:anywhere]">Replace {o.replaces}</span>}>
						That address stops getting reports from this record.
					</RadioCard>
				))}
			</fieldset>
			{picked ? <RecordToPublish replace={!!plan.current} name={plan.name} value={picked.record} /> : <p className="text-sm text-ink-2">Choose an option to see the record to publish.</p>}
		</div>
	);
}

/** A TXT string holds at most 255 characters; a longer record is published as several quoted strings in one record. */
export function txtStrings(value: string): string {
	const parts: string[] = [];
	for (let i = 0; i < value.length; i += 255) parts.push(`"${value.slice(i, i + 255)}"`);
	return parts.join(' ');
}

function RecordToPublish({ replace, name, value }: { replace: boolean; name: string; value: string }) {
	const long = value.length > 255;
	return (
		<div className="space-y-2">
			<RecordBlock
				title={replace ? `Replace the TXT record at ${name} with` : 'Add this TXT record at your DNS provider'}
				record={{ type: 'TXT', name, value: long ? txtStrings(value) : value }}
			/>
			{long ? (
				<p className="text-sm text-ink-2">
					This record is longer than 255 characters, so it must be entered as the quoted strings shown, one after another in the same TXT record.
				</p>
			) : null}
		</div>
	);
}

/**
 * A record of the subdomain's own, built by the same rule as every other offered record (offerEnforcement + recordFor):
 * exactly the enforcement in force, inherited pct= and alignment included, never weaker or stricter.
 */
function InheritedOwnRecord({ plan, domain, address }: { plan: Extract<ReportAddressPlan, { kind: 'inherited' }>; domain: string; address: string }) {
	const coverage = inheritedCoverage(plan.from, plan.parent_record, plan.policy);
	const e = offerEnforcement(coverage);
	if (!e) return null;
	const align = [e.adkim ? `adkim=${e.adkim}` : null, e.aspf ? `aspf=${e.aspf}` : null].filter(Boolean).join(', ');
	// Failure reports (RFC 7489 ruf= and its fo= options) are not part of the enforcement in force: a record of its own does not carry them.
	const tags = parseDmarcTags(plan.parent_record);
	const failureTags = (['ruf', 'fo'] as const).filter((t) => tags[t] !== undefined);
	return (
		<div className="space-y-2">
			<p className="text-sm text-ink-2">
				Or give {domain} a record of its own. It keeps {keptEnforcement(coverage, e)}
				{align ? ` with ${align}` : ''}, so nothing changes for its mail, and its reports go only to the report address. Later changes to {plan.from}&apos;s record no
				longer apply to it.
				{failureTags.length ? (
					<>
						{' '}
						{plan.from}&apos;s failure-report settings ({failureTags.map((t) => `${t}=`).join(', ')}) are not carried over: no failure reports are requested for {domain}.
					</>
				) : null}
			</p>
			<RecordToPublish replace={false} name={plan.own.name} value={offeredDmarcRecord(null, coverage, address) ?? ''} />
		</div>
	);
}
