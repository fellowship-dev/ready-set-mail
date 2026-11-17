import { ConnectCloudflareLink } from '../../../components/ConnectCloudflareLink';
import { Alert, CheckResult, CheckResultList, RecordBlock, StatusDot, toast } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { WriteButton } from '../../../components/states';
import { CopyButton } from '../../../components/wizard/CopyButton';
import { TxtRecord } from '../../../components/wizard/RecordPair';
import { DnsHostLine } from '../../../components/domain/DnsHostLine';
import { ConnectReports } from '../../../components/reports/ConnectReports';
import { PublicDnsLive } from '../../../components/domain/PublicDnsLive';
import { SeverityBadge } from '../../../components/wizard/SeverityBadge';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import { errorMessage } from '../../../lib/api';
import { useApplyDmarc, type ApplyDmarcResponse } from '../../../lib/apply-dmarc';
import { dmarcCoverage, inheritedSentence, keptEnforcement, offerEnforcement, offeredDmarcRecord } from '../../../lib/dmarc-coverage';
import { useHosted } from '../../../lib/session';
import { reachWords, reportsArrive, useReportAddress, useReportIntakeEnabled } from '../../../lib/report-address';
import { ReachStatement } from '../../../components/reports/ReachStatement';
import { buildRecommendedRecord, dmarcRecordProblem, hasReportAddress, parseDmarcPolicy } from '../../../lib/dmarc-record';
import type { OnboardingStatus } from '../../../lib/types';
import { setupKeys } from './hooks';
import { NextDmarcStep } from '../../../components/domain/NextDmarcStep';
import type { StepProps } from './SpfStep';
import { dmarcSeverity, dnsErrorDetail, dnsErrorsFor } from './steps';

export function DmarcStep({ status, onNext, onSkip, onRetry }: StepProps) {
	const qc = useQueryClient();
	const { dmarc, cf_available } = status;
	const dmarcFailed = dnsErrorsFor(status, 'dmarc');
	const authFailed = dnsErrorsFor(status, 'authRecord');
	const [applied, setApplied] = useState(false);
	/** The record as written (the server adds our address by the report-address rules), and what happened to the domain's reports. */
	const [written, setWritten] = useState<ApplyDmarcResponse | null>(null);
	const [authProvisioned, setAuthProvisioned] = useState(false);

	// The report address is top-level in the status, and empty when the domain was added without a reports domain (or, hosted, is not connected yet).
	// Hosted with report intake: our address is written into a record only by Connect reports (the panel below, ADR 0020), which reads the record as it is
	// now, so this step never builds a record that carries it and never sends one to apply-dmarc.
	const reportsPanel = useReportIntakeEnabled();
	const rua = hasReportAddress(status.rua_address) ? status.rua_address : null;
	const lookupSeverity = dmarcSeverity(dmarc, dmarcFailed.length > 0);
	// Hosted, before report intake is connected: no domain has a report address, so the step judges only what DNS shows
	// (a record or none) and never asks for an rua= that does not exist.
	const hostedMode = useHosted();
	// Whether reports reach this name, and how, is the server's one answer (`reach`: its own connection, through its parent, or through the record that
	// applies): this step says what the panel says. Before that is known (or without hosted intake) only the stored address is left.
	const reach = useReportAddress(status.domain_id, hostedMode && reportsPanel);
	const reachSaid = reachWords(reach.data);
	const hostedNoReports = hostedMode && !(reportsArrive(reach.data) ?? !!rua);
	// What covers this name when it has no record of its own: a parent's policy, nothing, or unknown (lookup failed).
	const coverage = dmarcCoverage(status, dmarcFailed.length > 0);
	// Without a report address nothing reaches Ready Set Mail, whatever the record says, so it is never "configured".
	// The record that applies to this name (its organizational domain's) already sends reports here: nothing is missing, whatever the name's own lookup shows.
	const inheritedReports = reach.data?.available === true && reach.data.reach.kind === 'inherited_record' && coverage.kind === 'inherited';
	const severity = hostedNoReports || inheritedReports
		? coverage.kind === 'unknown'
			? 'unknown'
			: coverage.kind === 'own'
				? 'info'
				: coverage.kind === 'none'
					? 'error'
					: coverage.policy === 'quarantine' || coverage.policy === 'reject'
						? 'info'
						: 'warning'
		: !rua && lookupSeverity === 'info'
			? 'warning'
			: lookupSeverity;
	// Adding our rua= must never relax an existing policy, so keep p= as it is and only default to none for a new record.
	// No report address, no recommended record: a record ending in `mailto:` is broken, so there is nothing to copy.
	// Hosted: a plain p=none record (no rua=) only when no policy applies at all. A record of its own would replace an
	// inherited policy, so an inherited, unknown or failed lookup gets no offer: never weaker than the effective policy.
	// Self-host with no record of its own: the new record replaces whatever it inherits, so it starts at the inherited
	// policy when that enforces (never weaker), and nothing is offered when the policy that applies is unknown.
	// A record receivers do not apply as written (an invalid p= or sp=): never "configured", whatever its rua= says. The
	// shared sentence says what receivers do with it; the next step below says what to fix.
	const recordProblem = dmarc.found && !applied && dmarcFailed.length === 0 ? dmarcRecordProblem(dmarc.current_record ?? null, `_dmarc.${status.domain}`) : null;
	const floor = offerEnforcement(coverage);
	const recommended = rua
		? offeredDmarcRecord(dmarc.current_record, coverage, rua)
		: hostedNoReports && coverage.kind === 'none'
			? offeredDmarcRecord(null, coverage, null)
			: null;

	const patch = (fn: (s: OnboardingStatus) => OnboardingStatus) => qc.setQueryData<OnboardingStatus>(setupKeys.status(status.domain_id), (s) => (s ? fn(s) : s));

	const apply = useApplyDmarc(status.domain_id);
	const applyRecord = () =>
		apply.mutate(recommended, {
			onSuccess: (res) => {
				setApplied(true);
				setWritten(res);
				toast({ variant: 'success', title: 'DMARC record written to Cloudflare', description: 'Waiting to show in public DNS.' });
				patch((s) => ({ ...s, dmarc: { ...s.dmarc, found: true, has_our_rua: false, current_record: res.record } }));
			},
		});

	// Re-applying the current record makes the server create the cross-domain authorization record as a side effect.
	const provision = useApplyDmarc(status.domain_id);
	const provisionAuth = () =>
		provision.mutate(dmarc.current_record ?? null, {
			onSuccess: () => {
				setAuthProvisioned(true);
				toast({ variant: 'success', title: 'Authorization record created' });
				patch((s) => ({ ...s, dmarc: { ...s.dmarc, auth_record: s.dmarc.auth_record ? { ...s.dmarc.auth_record, found: true } : s.dmarc.auth_record } }));
			},
		});

	const auth = dmarc.auth_record;
	const authFound = auth?.found || authProvisioned;

	return (
		<StepCard title="DMARC policy" badge={<SeverityBadge severity={applied ? 'info' : recordProblem ? 'error' : severity} />}>
			{dmarcFailed.length > 0 ? (
				<>
					<DnsHostLine domain={status.domain} />
					<CheckResultList>
						<CheckResult
							status="error"
							title={`DMARC for _dmarc.${status.domain}`}
							summary={`The DNS lookup failed (${dnsErrorDetail(dmarcFailed[0] ?? '')}).`}
							onRetry={onRetry}
						/>
					</CheckResultList>
					<p className="text-sm text-ink-2">We cannot tell whether you already have a DMARC record, so we will not suggest creating one. Try again, or continue and come back.</p>
				</>
			) : (
				<>
					{dmarc.current_record ? (
						<TxtRecord title="Current record" name="_dmarc" value={dmarc.current_record} />
					) : coverage.kind === 'inherited' ? null : (
						// An inherited policy is explained below ("no DMARC record of its own…"): "No DMARC record found" would contradict it.
						<p className="text-sm text-ink-2">
							No DMARC record found for <strong className="text-ink-1">_dmarc.{status.domain}</strong>.
						</p>
					)}
					{reachSaid ? <ReachStatement words={reachSaid} /> : null}
					{hostedNoReports ? (
						<>
							<div className="space-y-1">
								<StatusDot status="unknown" label="Reports not connected yet" className="font-medium" />
								<p className="text-sm text-ink-2">No reports reach Ready Set Mail for this name, so nobody can confirm yet that every service sending as it passes.</p>
								{/* Why reports cannot be connected here, in the connect panel's own words (nothing when this deployment takes no hosted reports). */}
								<ConnectReports domain={{ id: status.domain_id, domain: status.domain }} bare />
							</div>
						</>
					) : null}
					{/* The record to publish comes first (FOLD-01, FOLD-02): where to add it and the sentences about it follow. */}
					{(severity === 'error' || severity === 'warning') && recommended && !applied && reportsPanel && rua ? (
						<ConnectReports domain={{ id: status.domain_id, domain: status.domain }} bare />
					) : (severity === 'error' || severity === 'warning') && recommended && !applied ? (
						<div className="space-y-3">
							{/* Apply writes this record itself: nothing to copy. Without Cloudflare it is the record to paste. */}
							<TxtRecord title={cf_available ? 'The record Ready Set Mail will write' : 'Recommended record'} name="_dmarc" value={recommended} copyable={!cf_available} />
							<div className="flex flex-col gap-2 sm:flex-row">
								{cf_available ? (
									<WriteButton loading={apply.isPending} onClick={applyRecord}>
										Apply via Cloudflare
									</WriteButton>
								) : (
									<CopyButton text={recommended} />
								)}
							</div>
							{!cf_available ? <ConnectCloudflareLink /> : null}
							{apply.isError ? (
								<Alert variant="danger" title="Could not apply the record">
									{errorMessage(apply.error)}
								</Alert>
							) : null}
						</div>
					) : null}
					<DnsHostLine domain={status.domain} />
					{hostedNoReports ? (
						<>
							{coverage.kind === 'none' ? (
								<p className="text-sm text-ink-2">
									No DMARC policy applies to this name, so receiving servers have no instruction for mail that fails SPF and DKIM. Publish this record with{' '}
									<code className="font-mono text-ink-1">p=none</code>: it only monitors, so no mail is blocked or redirected.
								</p>
							) : coverage.kind === 'inherited' ? (
								<p className="text-sm text-ink-2">{inheritedSentence(status.domain, coverage)}</p>
							) : coverage.kind === 'unknown' ? (
								<p className="text-sm text-ink-2">We could not tell which DMARC policy applies to this name, so no record is offered. Try again in a moment.</p>
							) : (
								<p className="text-sm text-ink-2">
									{applied ? 'The record was written to Cloudflare. Public DNS can take a few minutes to show it.' : recordProblem ?? 'Your DMARC record is published, read from public DNS.'}
								</p>
							)}
						</>
					) : null}
					{!rua && !applied && !hostedNoReports ? (
						<Alert variant="warning" title="Report address not configured yet">
							This domain has no Ready Set Mail report address, so there is no record to copy yet. A DMARC record needs one to send reports here.
						</Alert>
					) : null}
					{!hostedNoReports && !applied && coverage.kind === 'inherited' ? (
						// Every mode says which policy is in force for this name before anything is offered.
						<p className="text-sm text-ink-2">
							{inheritedSentence(status.domain, coverage)}
							{rua && floor && !reachSaid && !reach.isLoading ? ` To receive reports here, publish the record below: it keeps ${keptEnforcement(coverage, floor)} and adds Ready Set Mail's report address.` : ''}
						</p>
					) : null}
					{rua && !applied && coverage.kind === 'unknown' && !dmarc.found ? (
						<p className="text-sm text-ink-2">We could not tell which DMARC policy applies to this name, so no record is offered. Try again in a moment.</p>
					) : null}
					{severity === 'error' && rua && !applied && coverage.kind === 'none' ? (
						<p className="text-sm text-ink-2">
							Without a DMARC record receiving servers send no reports, so Ready Set Mail has nothing to analyse. Create one with <code className="font-mono text-ink-1">p=none</code>{' '}
							(monitor only) so reports start flowing.
						</p>
					) : null}
					{recordProblem && !hostedNoReports ? (
						<Alert variant="warning" title="This DMARC record is not applied as written">
							{recordProblem}
						</Alert>
					) : null}
					{severity === 'warning' && rua && !applied && !recordProblem ? (
						<p className="text-sm text-ink-2">
							Your DMARC record exists but does not send reports to Ready Set Mail. Add <code className="font-mono text-ink-1">rua=mailto:{rua}</code> to receive
							aggregate reports.
						</p>
					) : null}
					{applied && written ? (
						<Alert variant="success" title="DMARC record written to Cloudflare">
							<PublicDnsLive domain={status.domain} record={written.record} />
							<p className="mt-2">Reports are not connected for this name.</p>
						</Alert>
					) : (severity === 'info' && !hostedNoReports && !recordProblem && !reachSaid) ? (
						<Alert variant="info" title="Reports are configured">
							Reports will start arriving within 24 hours. Once there is data, the dashboard guides you from <code className="font-mono">p=none</code> to{' '}
							<code className="font-mono">p=reject</code> safely.
						</Alert>
					) : null}
					{/* A record of its own is in place: the next step toward enforcement, from the shared rule. */}
					{dmarc.found && dmarc.current_record && !applied && ((severity !== 'error' && severity !== 'warning') || recordProblem) ? (
						<NextDmarcStep domain={{ id: status.domain_id, domain: status.domain, rua_address: status.rua_address }} />
					) : null}
				</>
			)}

			{/* The authorization record only matters next to a DMARC record: none published and none offered, none required. Hosted: every domain
			    reports to the shared address, whose own domain authorizes any policy domain (RFC 9990 section 4), so there is nothing per domain to check. */}
			{auth && !hostedMode && !hostedNoReports && (dmarc.found || !!recommended) ? (
				<section aria-label="Report authorization record" className="space-y-2">
					<h3 className="text-sm font-semibold text-ink-1">Report authorization record</h3>
					<CheckResultList>
						{authFailed.length > 0 ? (
							<CheckResult
								status="error"
								title="Authorization record"
								summary={`The DNS lookup failed (${dnsErrorDetail(authFailed[0] ?? '')}).`}
								onRetry={onRetry}
							/>
						) : authFound ? (
							<CheckResult status="pass" statusLabel="Found" title="Authorization record" summary={`${auth.record_name ?? 'The record'} authorizes this domain to receive DMARC reports.`} />
						) : !auth.record_name ? (
							// No reports domain: there is no authorization record to look for, so nothing is missing.
							<CheckResult
								status="neutral"
								title="Authorization record"
								summary="No reports domain is configured, so there is no authorization record to check. Set one up in Routing and this check will run."
							/>
						) : (
							<CheckResult
								status="missing"
								statusLabel="Missing"
								title="Authorization record"
								summary="RFC 7489 requires a TXT record to authorize cross-domain report delivery. Without it, some providers silently drop DMARC reports."
							>
								{auth.record_name ? (
									<div className="mt-2 space-y-3">
										<RecordBlock title="Required record" record={{ type: 'TXT', name: auth.record_name, value: 'v=DMARC1;' }} />
										{cf_available && dmarc.current_record ? (
											<WriteButton loading={provision.isPending} onClick={() => provisionAuth()}>
												Create via Cloudflare
											</WriteButton>
										) : null}
										{provision.isError ? (
											<Alert variant="danger" title="Could not create the record">
												{errorMessage(provision.error)}
											</Alert>
										) : null}
									</div>
								) : null}
							</CheckResult>
						)}
					</CheckResultList>
				</section>
			) : null}

			<StepNav onNext={onNext} onSkip={onSkip} showSkip={severity !== 'info' && !applied} />
		</StepCard>
	);
}
