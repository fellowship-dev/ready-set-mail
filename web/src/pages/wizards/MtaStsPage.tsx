import { Alert, Badge, Button, Card, CardContent, StatusDot } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ConnectCloudflareLink } from '../../components/ConnectCloudflareLink';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { CheckList } from '../../components/mta-sts/CheckList';
import { RecordList } from '../../components/mta-sts/RecordList';
import { ReportList } from '../../components/mta-sts/ReportList';
import { Disclosure, LoadError, PageSkeleton, ReadOnlyNotice, WriteButton } from '../../components/states';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, useInvalidateDomain } from '../../lib/domain-queries';
import { formatDate, formatDateTime } from '../../lib/format';
import { ENFORCE_MAX_AGE, holdSentence, maxAgeWords, senderNames, mtaStsExplainer, policyUrl, stateSentence, utc } from '../../lib/mta-sts';
import { useDomain } from '../../lib/queries';
import type { MtaStsDisableResult, MtaStsEnforceCheck, MtaStsStatus, MtaStsVerifyResult } from '../../lib/types';

const SETUP_STATES = ['creating', 'waiting_records', 'waiting_certificate', 'waiting_policy', 'waiting_txt'];
/** While a setup waits for DNS or a certificate the page looks again by itself, for this long. */
const AUTO_CHECK_MS = 30_000;
const AUTO_CHECK_FOR_MS = 30 * 60_000;

function Section({ title, children, badge }: { title: ReactNode; children: ReactNode; badge?: ReactNode }) {
	return (
		<Card>
			<CardContent className="space-y-4 sm:p-6 [&>p]:max-w-prose">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
					{badge}
				</div>
				{children}
			</CardContent>
		</Card>
	);
}

function MxList({ hosts }: { hosts: string[] }) {
	return (
		<ul aria-label="MX hosts" className="list-disc space-y-0.5 pl-5 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">
			{hosts.map((h) => (
				<li key={h}>{h}</li>
			))}
		</ul>
	);
}

export function MtaStsPage() {
	const domainId = useRouteDomainId();
	const { domain } = useDomain(domainId);
	const name = domain?.domain ?? null;
	const qc = useQueryClient();
	const invalidateDomain = useInvalidateDomain(domainId);
	const path = `/api/domains/${domainId}/mta-sts`;
	const queryKey = domainKeys.mta(domainId);
	const q = useQuery({ queryKey, queryFn: () => api<MtaStsStatus>(path), staleTime: 0, refetchOnMount: 'always' });

	const [checked, setChecked] = useState<MtaStsVerifyResult | null>(null);
	const [removed, setRemoved] = useState<MtaStsDisableResult | null>(null);
	const [dialog, setDialog] = useState<'enforce' | 'testing' | 'off' | null>(null);
	const back = `/domains/${domainId}`;
	// The router keeps the scroll position of the page it came from (the DNS tools sit at the bottom of the domain page): start at the top.
	useEffect(() => {
		window.scrollTo?.({ top: 0 });
	}, []);

	const refresh = async () => {
		await Promise.all([qc.invalidateQueries({ queryKey }), invalidateDomain()]);
	};
	const enable = useMutation({
		mutationFn: () => api<MtaStsStatus>(path, { method: 'POST' }),
		onSuccess: async (r) => {
			qc.setQueryData(queryKey, r);
			setChecked(null);
			await invalidateDomain();
		},
	});
	const check = useMutation({
		mutationFn: () => api<MtaStsVerifyResult>(`${path}/verify`, { method: 'POST' }),
		onSuccess: async (r) => {
			setChecked(r);
			await refresh();
		},
	});
	const mode = useMutation({
		mutationFn: (m: 'testing' | 'enforce') => api<{ ok: boolean }>(path, { method: 'PATCH', body: { mode: m } }),
		onSuccess: async () => {
			setDialog(null);
			setChecked(null);
			await refresh();
		},
	});
	const dismiss = useMutation({
		mutationFn: () => api(path, { method: 'PATCH', body: { dismiss_notice: true } }),
		onSuccess: refresh,
	});
	const turnOff = useMutation({
		mutationFn: () => api<MtaStsDisableResult>(path, { method: 'DELETE' }),
		onSuccess: async (r) => {
			setDialog(null);
			setRemoved(r ?? { ok: true, kept: [], operator: 'none', message: '' });
			await refresh();
		},
	});

	// A setup that waits for DNS or a certificate looks again by itself (the same check as the button), for a while.
	const waiting = !!q.data?.config && SETUP_STATES.includes(q.data.config.state) && q.data.config.state !== 'creating';
	useEffect(() => {
		if (!waiting) return;
		const started = Date.now();
		const t = setInterval(() => {
			if (document.visibilityState === 'hidden' || Date.now() - started > AUTO_CHECK_FOR_MS || check.isPending) return;
			check.mutate();
		}, AUTO_CHECK_MS);
		return () => clearInterval(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [waiting]);

	let body: ReactNode;
	if (removed) body = <RemovedResult result={removed} domain={name} back={back} via={q.data?.config?.via ?? null} />;
	else if (q.isPending) body = <PageSkeleton label="Loading MTA-STS" />;
	else if (q.isError) body = <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load MTA-STS" />;
	else {
		const s = q.data;
		const c = s.config;
		if (!c) {
			body = (
				<>
					{s.retiring ? <Retiring r={s.retiring} /> : null}
					{s.setup_expired ? (
						<Alert variant="info" title="Setup was stopped">
							<p>{s.setup_expired.notice}</p>
							<div className="mt-2">
								<WriteButton variant="secondary" size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
									Dismiss
								</WriteButton>
							</div>
						</Alert>
					) : null}
					{s.available ? <Preview s={s} name={name} busy={enable.isPending} error={enable.isError ? errorMessage(enable.error) : null} onEnable={() => enable.mutate()} onRetry={() => void q.refetch()} /> : <Unavailable s={s} name={name} back={back} />}
				</>
			);
		} else {
			const setup = SETUP_STATES.includes(c.state);
			const served = s.served ?? null;
			const unreachable = !setup && served?.ok === false;
			// The server fetches the policy when this view is older than ten minutes, before it answers: `served` is that result, or, when the fetch got no answer in time, the last known one.
			const untried = !setup && !!served?.could_not_check;
			const isServed = !setup && served?.ok === true && !untried;
			const unproved = !setup && served?.ok == null; // never fetched
			const checkedAt = served?.checked_at ? `Checked ${utc(served.checked_at)}` : null;
			const checksAllOk = !!checked && checked.checks.every((k) => k.state === 'ok' || k.state === 'not_applicable');
			const manualRecords = s.records.filter((r) => r.add_now);
			const canEnforce = !!s.enforce?.allowed && !unreachable;
			body = (
				<>
					<Section
						title="Where it stands"
						badge={
							<Badge variant={setup ? 'info' : 'success'}>
								{setup ? <Clock aria-hidden /> : <CheckCircle2 aria-hidden />}
								{setup ? 'Setting up' : c.mode === 'enforce' ? 'Enforced' : 'Testing'}
							</Badge>
						}
					>
						<p className="text-sm text-ink-1">{stateSentence(c.state, c.mode)}</p>
						{isServed ? (
							<div className="flex flex-wrap items-center gap-x-3">
								<StatusDot status="ok" label={`Served at ${policyUrl(name ?? '')}`} />
								<span className="text-sm text-ink-2">{checkedAt}</span>
							</div>
						) : null}
						{untried ? (
							<p className="text-sm text-ink-1">
								Could not check just now.{served?.ok == null ? '' : ` Last known: ${served.ok ? `served at ${policyUrl(name ?? '')}` : 'the policy cannot be reached'}, checked ${served.checked_at ? utc(served.checked_at) : 'never'}.`}
							</p>
						) : null}
						{unreachable && !untried ? (
							<Alert variant="warning" title="The policy cannot be reached">
								<p>{served?.message}</p>
								<p className="text-ink-2">{checkedAt}</p>
							</Alert>
						) : null}
						{c.last_error ? <Alert variant="warning" title="The last check had a problem">{c.last_error}</Alert> : null}
						{c.notice ? (
							<Alert variant="info" title="Something changed">
								<p>{c.notice}</p>
								<div className="mt-2">
									<WriteButton variant="secondary" size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
										Dismiss
									</WriteButton>
								</div>
							</Alert>
						) : null}
						{manualRecords.length > 0 ? (
							<div className="space-y-2">
								<p className="text-sm font-medium text-ink-1">Add {manualRecords.length === 1 ? 'this record' : 'these records'} at your DNS host</p>
								<RecordList records={manualRecords} copyable label="Records to add" />
							</div>
						) : null}
						{checked && checked.checks.length > 0 && (setup || unreachable || unproved || !checksAllOk) ? <CheckList checks={checked.checks} /> : null}
						{check.isError ? <Alert variant="danger" title="Could not check">{errorMessage(check.error)}</Alert> : null}
						{/* Check now is the one action of a setup that waits and of a policy that cannot be reached; while "served" is claimed it is there too, small, because that claim can go stale. */}
						{setup || unreachable || unproved ? (
							<div className="flex flex-wrap items-center gap-3">
								<WriteButton variant="primary" loading={check.isPending} onClick={() => check.mutate()}>
									Check now
								</WriteButton>
								{setup && c.last_checked_at ? <span className="text-sm text-ink-2">Last checked {formatDateTime(c.last_checked_at)}.</span> : null}
							</div>
						) : (
							<div>
								<WriteButton variant="secondary" size="sm" loading={check.isPending} onClick={() => check.mutate()}>
									Check now
								</WriteButton>
							</div>
						)}
					</Section>

					{/* Enforce is not asked of a setup that is still waiting: its reasons would only say "setup is not finished". */}
					{s.enforce && !setup ? (
						<Section title="Enforce">
							{/* Brand blue is for the one action that is available: a disabled Switch to enforce is secondary. */}
							<WriteButton variant={canEnforce && !unproved ? 'primary' : 'secondary'} disabled={!canEnforce} onClick={() => setDialog('enforce')}>
								Switch to enforce
							</WriteButton>
							{canEnforce ? null : (
								<>
									<EnforceRule checks={s.enforce.checks} reasons={s.enforce.reasons} />
									<p className="text-sm text-ink-2">{s.evidence?.no_reports_note ?? 'A domain that receives no TLS reports can never switch to enforce.'}</p>
								</>
							)}
						</Section>
					) : !setup ? (
						<Section title="Enforce">
							<WriteButton variant="secondary" onClick={() => setDialog('testing')}>
								Switch to testing
							</WriteButton>
						</Section>
					) : null}

					{setup ? null : (
						<Section title="TLS reports, last 30 days">
							{s.summary && s.reports.length > 0 ? (
								<p className="text-sm text-ink-2">
									{s.summary.sts_success.toLocaleString()} successful and {s.summary.sts_failure.toLocaleString()} failed sessions, from {s.summary.report_count} signed {s.summary.report_count === 1 ? 'report' : 'reports'}.
									{s.summary.report_count > s.reports.length ? ` The newest ${s.reports.length} are listed.` : ''}
								</p>
							) : null}
							<ReportList reports={s.reports} />
							{s.evidence && s.evidence.uncounted_reports > 0 ? (
								<p className="text-xs text-ink-2">
									{s.evidence.uncounted_reports} more {s.evidence.uncounted_reports === 1 ? 'report arrived but is' : 'reports arrived but are'} not counted: sender not verified.
								</p>
							) : null}
						</Section>
					)}

					<Disclosure title="Show records">
						<div className="space-y-3">
							<RecordList records={s.records} copyable={c.via === 'manual'} label="The three records" />
							<p className="text-sm text-ink-2">
								MX hosts in the policy: <span className="font-mono [overflow-wrap:anywhere]">{c.mx_host_list.join(', ')}</span>. {holdSentence(c.max_age, c.mode === 'testing' ? s.disable?.after : null)}
							</p>
						</div>
					</Disclosure>

					<div className="space-y-2">
						{s.disable && !s.disable.allowed ? <p className="text-sm text-ink-2">{s.disable.reason}</p> : null}
						<WriteButton variant="secondary" disabled={!!s.disable && !s.disable.allowed} onClick={() => setDialog('off')}>
							Turn off MTA-STS
						</WriteButton>
					</div>

					<ConfirmDialog
						open={dialog === 'enforce'}
						onOpenChange={(o) => !o && (setDialog(null), mode.reset())}
						title="Switch to enforce?"
						description={`From now on, senders that check MTA-STS deliver to ${name ?? 'your domain'} only over a verified encrypted connection to a listed MX host; they refuse otherwise. The evidence is signed reports from ${senderNames(s.evidence?.reporters)}: senders that send none are not covered. You can switch back to testing, but senders that fetched the enforce policy may keep it for up to ${maxAgeWords(ENFORCE_MAX_AGE)}.`}
						confirmLabel="Switch to enforce"
						busyLabel="Switching…"
						busy={mode.isPending}
						error={mode.isError ? errorMessage(mode.error) : null}
						onConfirm={() => mode.mutate('enforce')}
					/>
					<ConfirmDialog
						open={dialog === 'testing'}
						onOpenChange={(o) => !o && (setDialog(null), mode.reset())}
						title="Switch to testing?"
						description={`Senders will deliver again even without a verified encrypted connection, and keep reporting. Senders that already fetched the enforce policy may keep it for up to ${maxAgeWords(c.max_age)}.`}
						confirmLabel="Switch to testing"
						busyLabel="Switching…"
						busy={mode.isPending}
						error={mode.isError ? errorMessage(mode.error) : null}
						onConfirm={() => mode.mutate('testing')}
					/>
					<ConfirmDialog
						open={dialog === 'off'}
						onOpenChange={(o) => !o && (setDialog(null), turnOff.reset())}
						title="Turn off MTA-STS?"
						description={`The policy and the records Ready Set Mail wrote are removed. Senders that already fetched the policy may keep it for up to ${maxAgeWords(c.max_age)}.`}
						confirmLabel="Turn off"
						busyLabel="Turning off…"
						variant="danger"
						busy={turnOff.isPending}
						error={turnOff.isError ? errorMessage(turnOff.error) : null}
						onConfirm={() => turnOff.mutate()}
					/>
				</>
			);
		}
	}

	return (
		<div className="space-y-6">
			<WizardHeader backTo={back} title={name ? `MTA-STS for ${name}` : 'MTA-STS'} subtitle={mtaStsExplainer(name)} />
			<ReadOnlyNotice />
			{body}
		</div>
	);
}

/** The whole enforce rule, once, with each line met or missing now (the server decides; `reasons` is its own flat list for an older server). */
function EnforceRule({ checks, reasons }: { checks?: MtaStsEnforceCheck[]; reasons: string[] }) {
	if (!checks) {
		return (
			<ul aria-label="Not yet" className="list-disc space-y-1 pl-5 text-sm text-ink-2">
				{reasons.map((r) => (
					<li key={r}>{r}</li>
				))}
			</ul>
		);
	}
	return (
		<div className="space-y-2">
			<p className="text-sm text-ink-1">Enforce needs:</p>
			<ul aria-label="What enforce needs" className="space-y-2 text-sm">
				{checks.map((k) => (
					<li key={k.key} className="flex gap-2">
						{k.met ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />}
						<span className={k.met ? 'text-ink-2' : 'text-ink-1'}>
							<span className="font-medium">{k.met ? 'Met' : 'Missing'}:</span> {k.label}
							{k.met ? null : <span className="block text-ink-2">{k.reasons.join(' ')}</span>}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** A policy being taken down (a lost proof, a removed or an evicted domain): what senders may still do, and until when. */
function Retiring({ r }: { r: NonNullable<MtaStsStatus['retiring']> }) {
	return (
		<Alert variant="info" title="MTA-STS is being switched off">
			<p>{r.message.replace(/^MTA-STS is being switched off\. /, '')} Until {formatDate(r.until)}.</p>
		</Alert>
	);
}

function Unavailable({ s, name, back }: { s: MtaStsStatus; name: string | null; back: string }) {
	return (
		<Section title={`MTA-STS is not available${name ? ` for ${name}` : ''}`}>
			<p className="text-sm text-ink-1">{s.unavailable_message}</p>
			{s.unavailable_reason === 'needs_cloudflare' ? <ConnectCloudflareLink /> : null}
			<Button asChild variant="secondary">
				<Link to={back}>Back to the domain</Link>
			</Button>
		</Section>
	);
}

function Preview({ s, name, busy, error, onEnable, onRetry }: { s: MtaStsStatus; name: string | null; busy: boolean; error: string | null; onEnable: () => void; onRetry: () => void }) {
	const mx = s.mx_preview;
	const manual = s.via === 'manual';
	return (
		<Section title="Turn it on">
			<div className="space-y-2">
				<h3 className="text-sm font-semibold text-ink-1">Your mail servers</h3>
				{mx.status === 'ok' ? (
					<MxList hosts={mx.hosts} />
				) : mx.status === 'none' ? (
					<Alert variant="warning" title="No mail servers found">
						<p>{name ?? 'This domain'} has no MX records. Add them at your DNS host first.</p>
						<div className="mt-2">
							<Button variant="secondary" size="sm" onClick={onRetry}>
								Look again
							</Button>
						</div>
					</Alert>
				) : (
					<Alert variant="warning" title="Could not read your MX records">
						<p>The lookup failed just now ({mx.error}). This is not the same as having none.</p>
						<div className="mt-2">
							<Button variant="secondary" size="sm" onClick={onRetry}>
								Look again
							</Button>
						</div>
					</Alert>
				)}
			</div>

			{mx.status === 'ok' ? (
				<>
					<p className="text-sm text-ink-2">It starts in testing mode: mail is delivered as before and nothing is rejected.</p>
					{error ? <Alert variant="danger" title="Could not turn it on">{error}</Alert> : null}
					<div>
						<WriteButton loading={busy} onClick={onEnable}>
							{busy ? 'Turning on…' : 'Turn on in testing mode'}
						</WriteButton>
					</div>
				</>
			) : null}

			{manual ? (
				<div className="space-y-2">
					<p className="text-sm text-ink-2">After you turn it on, add these records at your DNS host.</p>
					<RecordList records={s.records} copyable label="Records" />
				</div>
			) : (
				<Disclosure title="Show records">
					<RecordList records={s.records} copyable={false} label="Records" />
				</Disclosure>
			)}
		</Section>
	);
}

function RemovedResult({ result, domain, back, via }: { result: MtaStsDisableResult; domain: string | null; back: string; via: 'cloudflare' | 'manual' | null }) {
	return (
		<Section title="MTA-STS is off">
			<ul className="list-disc space-y-1 pl-5 text-sm text-ink-1">
				{via === 'manual' ? <li>You added the records yourself: delete them at your DNS host too.</li> : <li>The records Ready Set Mail wrote are removed{result.kept.length ? ', except those below' : ''}.</li>}
				{result.operator === 'removed' ? <li>The policy server for {domain ?? 'the domain'} is removed.</li> : null}
				{result.operator === 'pending' ? <li>The policy server could not be removed just now. It is cleaned up automatically within a day.</li> : null}
			</ul>
			{result.kept.length > 0 ? (
				<Alert variant="warning" title="Kept, because you changed them">
					<ul className="list-disc space-y-1 pl-5">
						{result.kept.map((k) => (
							<li key={`${k.type}${k.name}`} className="[overflow-wrap:anywhere]">
								<code className="font-mono">{k.type} {k.name}</code>: {k.reason}
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			{result.message ? <p className="text-sm text-ink-2">{result.message}</p> : null}
			<Button asChild>
				<Link to={back}>Back to the domain</Link>
			</Button>
		</Section>
	);
}
