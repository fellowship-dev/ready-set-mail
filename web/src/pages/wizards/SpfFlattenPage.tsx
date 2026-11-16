import { ConnectCloudflareLink } from '../../components/ConnectCloudflareLink';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { Alert, Badge, Button, CheckResult, CheckResultList, toast } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice, WriteButton } from '../../components/states';
import { LookupBadge, RecordPair, TxtRecord } from '../../components/wizard/RecordPair';
import { StepCard } from '../../components/wizard/StepCard';
import { StepFooter } from '../../components/wizard/StepNav';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { api, ApiError, errorMessage } from '../../lib/api';
import { domainKeys } from '../../lib/domain-queries';
import { CHECK_AGAIN_NOW, droppedTerms, NOT_ALLOWED_ON_SENTENCE, NOT_NEEDED_WHY, onSentence, pendingSentence, PENDING_WHY, plural, spfState, SPF_CHECK_AT, SPF_LOOKUP_ALLOWED, staleSentence, stoppedSentence, TURN_ON_RISK } from '../../lib/spf-flatten';
import { RadioCard } from '../../components/wizard/RadioCard';
import { useAddOns } from '../../lib/session';
import type { SpfFlatConfig, SpfFlatPreview, SpfFlatStatus } from '../../lib/types';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';

const STEPS = ['Your record', 'Turn on'] as const;

interface FlattenData {
	flat: SpfFlatStatus;
	preview: SpfFlatPreview | null;
	/** The preview itself could not be read (not a refusal: the request failed). */
	previewFailed: boolean;
}

async function loadFlatten(domainId: number): Promise<FlattenData> {
	const flat = await api<SpfFlatStatus>(`/api/domains/${domainId}/spf-flatten`).catch((e: unknown): SpfFlatStatus => {
		if (e instanceof ApiError && e.status === 404) return { available: false, config: null, lookup_count: null };
		throw e;
	});
	if (flat.access?.allowed === false) return { flat, preview: null, previewFailed: false }; // the add-on went away: the preview route answers 404
	try {
		return { flat, preview: await api<SpfFlatPreview>(`/api/domains/${domainId}/spf-flatten/preview`), previewFailed: false };
	} catch {
		return { flat, preview: null, previewFailed: true };
	}
}

/** What discarding an edit drops: the terms of the record in Cloudflare now that the flattened record does not have. */
function dropSentence(live: string, flat: string): string {
	const dropped = droppedTerms(live, flat);
	return dropped.length ? `These will be dropped: ${dropped.join(', ')}.` : 'Nothing in it will be dropped.';
}

/** The page behind a pasted address on a workspace without the add-on: the same sentence the API gives. */
function NotAvailable() {
	return (
		<StepCard title="SPF flattening">
			<p className="text-sm text-ink-2">SPF flattening is not available on the hosted service.</p>
		</StepCard>
	);
}

export function SpfFlattenPage() {
	const available = useAddOns().spf_flattening;
	return available ? <SpfFlattenWizard /> : <NotAvailable />;
}

function SpfFlattenWizard() {
	const domainId = useRouteDomainId();
	const qc = useQueryClient();
	const [params] = useSearchParams();
	const queryKey = ['spf-flatten-wizard', domainId] as const;
	const q = useQuery({ queryKey, queryFn: () => loadFlatten(domainId), staleTime: 0, refetchOnMount: 'always' });
	const [step, setStep] = useState(0);
	const [anyway, setAnyway] = useState(false);
	const [confirm, setConfirm] = useState<'off' | 'discard' | null>(null);
	const [choice, setChoice] = useState<'adopt' | 'discard'>('adopt'); // the safe one: the person's edit is kept

	const reload = async () => {
		await qc.invalidateQueries({ queryKey });
		await qc.invalidateQueries({ queryKey: domainKeys.spf(domainId) });
		await qc.invalidateQueries({ queryKey: ['domains'] });
	};
	const enable = useMutation({
		mutationFn: () => api<{ ok: boolean; config: SpfFlatConfig }>(`/api/domains/${domainId}/spf-flatten`, { method: 'POST', body: { anyway } }),
		onSuccess: async () => {
			await reload();
			setStep(0);
		},
	});
	const turnOff = useMutation({
		mutationFn: () => api<{ restored?: boolean; why?: string } | undefined>(`/api/domains/${domainId}/spf-flatten`, { method: 'DELETE' }),
		onSuccess: async (res) => {
			setConfirm(null);
			toast(
				res && res.restored === false
					? { title: 'SPF flattening turned off', description: 'The record in Cloudflare was changed outside Ready Set Mail, so we left it as it is.', variant: 'warning' }
					: { title: 'SPF flattening turned off', description: 'Your original SPF record is back in Cloudflare.', variant: 'success' },
			);
			await reload();
			setStep(0);
		},
	});
	const adopt = useMutation({
		mutationFn: () => api<{ outcome: string; config: SpfFlatConfig }>(`/api/domains/${domainId}/spf-flatten/adopt`, { method: 'POST', body: {} }),
		onSuccess: async () => {
			toast({ title: 'Your edit is the new original', description: 'Ready Set Mail keeps it and flattens from it.', variant: 'success' });
			await reload();
		},
	});
	const checkNow = useMutation({
		mutationFn: (replace: boolean) => api<{ outcome: string; message?: string; config: SpfFlatConfig }>(`/api/domains/${domainId}/spf-flatten/refresh`, { method: 'POST', body: { replace } }),
		onSuccess: async (r) => {
			setConfirm(null);
			if (r.outcome === 'pending') toast({ title: 'Still waiting to confirm', description: r.message, variant: 'info' });
			else if (r.outcome === 'changed') toast({ title: 'Your record was updated', description: 'Your providers changed their addresses.', variant: 'success' });
			else if (r.outcome === 'unchanged') toast({ title: 'Checked', description: 'Nothing changed.', variant: 'success' });
			await reload();
		},
	});

	const back = `/domains/${domainId}`;
	let body;
	if (q.isPending) body = <PageSkeleton label="Reading your SPF record" />;
	else if (q.isError) body = <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load SPF flattening" />;
	else {
		const { flat, preview, previewFailed } = q.data;
		const state = spfState(flat);
		const toolsApi = flat.available;
		const allowed = flat.access?.allowed !== false;

		if (!allowed && state.kind === 'off') {
			body = <NotAvailable />;
		} else if (!allowed && state.kind !== 'off') {
			// The add-on went away while a domain had flattening on: the record keeps what the last check wrote and nothing refreshes it. Only what still works is offered.
			const c = state.config;
			body = (
				<>
					<StepCard title="SPF flattening is not available here any more">
						<p className="text-sm text-ink-2">{NOT_ALLOWED_ON_SENTENCE}</p>
						{turnOff.isError && !confirm ? <Alert variant="danger" title="That did not work">{errorMessage(turnOff.error)}</Alert> : null}
						<StepFooter
							start={<WriteButton variant="danger" onClick={() => setConfirm('off')}>Turn off</WriteButton>}
							end={<Button asChild><Link to={back}>Back to domain</Link></Button>}
						/>
						<RecordPair>
							<TxtRecord title="Your original record" value={c.original_record} />
							{c.flattened_record ? <TxtRecord title="Published record (from the last check)" value={c.flattened_record} copyable={false} /> : null}
						</RecordPair>
					</StepCard>
					<ConfirmDialog
						open={confirm === 'off'}
						onOpenChange={(o) => { if (!o) { setConfirm(null); turnOff.reset(); } }}
						title="Turn off SPF flattening?"
						description="Your original SPF record goes back in Cloudflare. It may need more than 10 lookups again."
						confirmLabel="Turn off"
						busyLabel="Turning off…"
						variant="danger"
						busy={turnOff.isPending}
						error={turnOff.isError ? errorMessage(turnOff.error) : null}
						onConfirm={() => turnOff.mutate()}
					/>
				</>
			);
		} else if (state.kind === 'on' || state.kind === 'problem' || state.kind === 'turning_off_failed' || state.kind === 'stopped') {
			const c = state.config;
			const review = params.get('review') === '1' && state.kind === 'problem' && (state.problem.kind === 'edited_outside' || state.problem.kind === 'record_missing');
			body = (
				<>
					{review ? (
						<StepCard title="Review the record">
							<p className="text-sm text-ink-2">
								{state.kind === 'problem' && state.problem.kind === 'record_missing'
									? 'There is no SPF record in Cloudflare now. Ready Set Mail does not add one by itself.'
									: 'The SPF record in Cloudflare is not the one Ready Set Mail published, so someone changed it there. We have left it as it is.'}
							</p>
							<RecordPair>
								{preview?.live ? <TxtRecord title="In Cloudflare now" value={preview.live} copyable={false} /> : <TxtRecord title="In Cloudflare now" value="(no SPF record)" copyable={false} />}
								{preview?.flat ? <TxtRecord title="Flattened from your original" value={preview.flat.record} copyable={false} /> : <TxtRecord title="Your original record" value={c.original_record} copyable={false} />}
							</RecordPair>
							{preview?.problem ? <Alert variant="warning">{preview.problem.message}</Alert> : null}
							{preview?.live && preview.flat ? (
								<fieldset className="space-y-2">
									<legend className="text-sm font-medium text-ink-1">What should Ready Set Mail do with your edit?</legend>
									<RadioCard name="spf-edit" value="adopt" checked={choice === 'adopt'} onChange={() => setChoice('adopt')} title="Use my edit as the new original">
										It becomes your original record, and the flattened record is made from it, so what you added stays. Addresses it already lists stay as written and no longer follow a provider.
									</RadioCard>
									<RadioCard name="spf-edit" value="discard" checked={choice === 'discard'} onChange={() => setChoice('discard')} title="Discard my edit">
										The flattened record from your original is written. {dropSentence(preview.live, preview.flat.record)}
									</RadioCard>
								</fieldset>
							) : null}
							{checkNow.isError ? <Alert variant="danger" title="That did not work">{errorMessage(checkNow.error)}</Alert> : null}
							{adopt.isError ? <Alert variant="danger" title="That did not work">{errorMessage(adopt.error)}</Alert> : null}
							<StepFooter
								start={
									<Button variant="ghost" onClick={() => setConfirm('off')}>
										Stop flattening
									</Button>
								}
								end={
									<WriteButton
										disabled={!preview?.flat || !preview.live}
										loading={adopt.isPending}
										onClick={() => (choice === 'adopt' ? adopt.mutate() : setConfirm('discard'))}
									>
										{choice === 'adopt' ? 'Use my edit' : 'Discard my edit'}
									</WriteButton>
								}
							/>
						</StepCard>
					) : (
						<StepCard title={state.kind === 'turning_off_failed' ? 'Turning off did not finish' : state.kind === 'stopped' ? 'SPF flattening has stopped' : 'SPF flattening is on'}>
							{state.kind === 'turning_off_failed' ? (
								<Alert variant="warning">{state.message} It is below: copy it into Cloudflare, or try again.</Alert>
							) : state.kind === 'stopped' ? (
								<Alert variant="warning">{stoppedSentence(state.reason)}</Alert>
							) : (
								<>
									<p className="text-sm text-ink-2">{onSentence(c)}</p>
									{state.kind === 'problem' ? <Alert variant="warning">{state.problem.message}</Alert> : null}
									{state.kind === 'on' && state.stale ? <p className="text-sm text-ink-2">{staleSentence(c)}</p> : null}
									{c.pending ? (
										<Alert variant="info" data-testid="spf-pending">
											<p>{pendingSentence(c.pending)}</p>
											<p className="mt-1">{PENDING_WHY}</p>
										</Alert>
									) : null}
								</>
							)}
							{turnOff.isError && !confirm ? <Alert variant="danger" title="That did not work">{errorMessage(turnOff.error)}</Alert> : null}
							{checkNow.isError ? <Alert variant="danger" title="That did not work">{errorMessage(checkNow.error)}</Alert> : null}
							<StepFooter
								start={
									state.kind === 'on' || state.kind === 'problem' ? (
										<div className="flex flex-wrap gap-2">
											<WriteButton variant="secondary" loading={checkNow.isPending} onClick={() => checkNow.mutate(false)}>
												{checkNow.isPending ? 'Checking…' : c.pending ? CHECK_AGAIN_NOW : 'Check now'}
											</WriteButton>
											<WriteButton variant="danger" onClick={() => setConfirm('off')}>
												Turn off
											</WriteButton>
										</div>
									) : (
										<div className="flex flex-wrap gap-2">
											<WriteButton variant="secondary" loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
												{turnOff.isPending ? 'Trying…' : state.kind === 'stopped' ? 'Try to put it back' : 'Try again'}
											</WriteButton>
											{state.kind === 'stopped' ? (
												state.reason === 'connection_gone' ? (
													<ConnectCloudflareLink>Reconnect Cloudflare</ConnectCloudflareLink>
												) : (
													<Button asChild variant="secondary">
														<Link to={back}>Prove ownership again</Link>
													</Button>
												)
											) : null}
										</div>
									)
								}
								end={
									<Button asChild>
										<Link to={back}>Back to domain</Link>
									</Button>
								}
							/>

							{state.kind === 'turning_off_failed' ? (
								<TxtRecord title="Your original record" value={c.original_record} />
							) : state.kind === 'stopped' ? (
								<RecordPair>
									<TxtRecord title="Your original record" value={c.original_record} />
									<TxtRecord title={preview?.live ? 'In Cloudflare now' : 'In Cloudflare (as of the last check; it cannot be read now)'} value={preview?.live ?? c.flattened_record ?? ''} copyable={false} />
								</RecordPair>
							) : (
								<>
									<RecordPair>
										<TxtRecord title="Your original record" value={c.original_record} badge={c.lookups_before !== null ? <LookupBadge count={c.lookups_before} /> : undefined} />
										{c.flattened_record ? <TxtRecord title="Published record" value={c.flattened_record} badge={c.lookups_after !== null ? <LookupBadge count={c.lookups_after} /> : undefined} /> : null}
									</RecordPair>
									{c.previous_record !== null ? <TxtRecord title="Before the last change" value={c.previous_record} copyable={false} /> : null}
								</>
							)}
						</StepCard>
					)}
					<ConfirmDialog
						open={confirm === 'off'}
						onOpenChange={(o) => {
							if (!o) {
								setConfirm(null);
								turnOff.reset();
							}
						}}
						title="Turn off SPF flattening?"
						description="Your original SPF record goes back in Cloudflare and Ready Set Mail stops checking your providers. It may need more than 10 lookups again."
						confirmLabel="Turn off"
						busyLabel="Turning off…"
						variant="danger"
						busy={turnOff.isPending}
						error={turnOff.isError ? errorMessage(turnOff.error) : null}
						onConfirm={() => turnOff.mutate()}
					/>
					<ConfirmDialog
						open={confirm === 'discard'}
						onOpenChange={(o) => !o && setConfirm(null)}
						title="Discard your edit?"
						description={preview?.live && preview.flat ? `The record in Cloudflare is replaced with the flattened record. ${dropSentence(preview.live, preview.flat.record)} What is there now is kept as the record before this change, and in the audit log.` : 'The record in Cloudflare is replaced with the flattened record.'}
						confirmLabel="Discard my edit"
						busyLabel="Replacing…"
						variant="danger"
						busy={checkNow.isPending}
						error={checkNow.isError ? errorMessage(checkNow.error) : null}
						onConfirm={() => checkNow.mutate(true)}
					/>
				</>
			);
		} else {
			const within = !!preview?.within_limits;
			const f = preview?.flat ?? null;
			const original = preview?.original ?? null;
			const lookups = f?.lookups_before ?? flat.lookup_count ?? null;
			const readFailed = previewFailed || (!original && !!preview?.problem);
			const footer0 = (
			<StepFooter
				start={
					within && original ? (
						<Button
							variant="ghost"
							onClick={() => {
								setAnyway(true);
								setStep(1);
							}}
						>
							Flatten anyway
						</Button>
					) : undefined
				}
				end={
					!readFailed && original && !within && f ? (
						<Button onClick={() => setStep(1)}>Continue</Button>
					) : (
						<Button asChild variant={readFailed ? 'secondary' : 'primary'}>
							<Link to={back}>Back to domain</Link>
						</Button>
					)
				}
			/>
			);
			body = (
				<>
					<WizardProgress label="Flattening progress" current={step} steps={STEPS.map((label, i) => ({ label, state: i < step ? 'complete' : 'pending' }))} />

					{step === 0 ? (
						<StepCard title="Your SPF record">
							{readFailed ? (
								<CheckResultList>
									<CheckResult status="error" title="SPF record" summary={`We could not read your SPF record just now${preview?.problem ? ` (${preview.problem.message})` : ''}.`} onRetry={() => void q.refetch()} />
								</CheckResultList>
							) : !original ? (
								<Alert variant="warning" title="No SPF record found">
									Flattening needs an SPF record to work from. Add one in the setup wizard first.
								</Alert>
							) : within ? (
								<>
									<TxtRecord title="Your record" value={original} badge={lookups !== null ? <LookupBadge count={lookups} /> : undefined} />
									<p className="text-sm text-ink-2">
										Your record needs {lookups} of the {SPF_LOOKUP_ALLOWED} lookups receivers allow, so it is fine as it is. Flattening is not needed.
									</p>
									<p className="text-sm text-ink-2">{NOT_NEEDED_WHY}</p>
								</>
							) : (
								<>
									{lookups !== null ? (
										<p className="text-sm text-ink-2">
											Your SPF record needs {lookups} lookups. Receivers stop at {SPF_LOOKUP_ALLOWED} (RFC 7208, section 4.6.4) and then treat SPF as an error, so your mail may stop passing SPF.
										</p>
									) : null}
									{footer0}
									<RecordPair>
										<TxtRecord title="Your record" value={original} badge={lookups !== null ? <LookupBadge count={lookups} /> : undefined} />
										{f ? (
											<TxtRecord
												title="Flattened"
												value={f.record}
												badge={
													<>
														<LookupBadge count={f.lookups_after} />
														<Badge variant="outline">{f.bytes} bytes</Badge>
													</>
												}
											/>
										) : (
											<div className="space-y-1.5">
												<p className="text-sm font-medium text-ink-1">Flattened</p>
												<Alert variant="warning" title="Cannot be flattened">
													{preview?.problem?.message ?? 'We could not work out the flattened record.'}
												</Alert>
											</div>
										)}
									</RecordPair>
									{f ? (
										<p className="text-sm text-ink-2">
											Flattening swaps {f.inlined.length === 1 ? 'one include' : `${plural(f.inlined.length, 'include')}`} for the addresses {f.inlined.length === 1 ? 'it lists' : 'they list'} today
											{f.kept_includes.length ? `; ${f.kept_includes.join(', ')} stay${f.kept_includes.length === 1 ? 's' : ''} as ${f.kept_includes.length === 1 ? 'an include' : 'includes'}` : ''}. We check your includes every day and update the
											record when they change.
										</p>
									) : null}
								</>
							)}
							{readFailed || !original || within ? footer0 : null}
						</StepCard>
					) : null}

					{step === 1 ? (
						<StepCard title="Turn on SPF flattening">
							<Alert variant="warning" title="This changes your live DNS">
								Turning on replaces the SPF record in Cloudflare with the flattened record. Your original record is kept; turning off puts it back.
							</Alert>
							<p className="text-sm text-ink-1" data-testid="spf-risk">{TURN_ON_RISK}</p>
							{anyway && within ? <p className="text-sm text-ink-2">{NOT_NEEDED_WHY}</p> : null}
							<p className="text-sm text-ink-2">
								Every day around {SPF_CHECK_AT} we read your includes again. If your providers changed their addresses we update the record. If we cannot read them we leave the record as it is and show it here.
							</p>
							{!toolsApi ? (
								<Alert variant="warning" title="Not available here">
									SPF flattening writes to Cloudflare DNS, and no Cloudflare connection is configured.
								</Alert>
							) : null}
							{!toolsApi ? <ConnectCloudflareLink /> : null}
							{enable.isError ? (
								<Alert variant="danger" title="Could not turn on SPF flattening">
									{errorMessage(enable.error)}
								</Alert>
							) : null}
							<StepFooter
								start={
									<Button variant="ghost" onClick={() => setStep(0)}>
										Back
									</Button>
								}
								end={
									<WriteButton loading={enable.isPending} disabled={!toolsApi || !original || !f} onClick={() => enable.mutate()}>
										{enable.isPending ? 'Turning on…' : 'Turn on flattening'}
									</WriteButton>
								}
							/>
							{original ? <TxtRecord title="Record to flatten" value={original} /> : null}
							{anyway && within && f ? <TxtRecord title="Flattened" value={f.record} copyable={false} /> : null}
						</StepCard>
					) : null}
				</>
			);
		}
	}

	// "On": after turning on the query reloads and the page is the "SPF flattening is on" view above.
	return (
		<div className="space-y-6">
			<WizardHeader backTo={back} title="SPF flattening" subtitle="Replace the includes in your SPF record with the addresses behind them." />
			<ReadOnlyNotice />
			{body}
		</div>
	);
}
