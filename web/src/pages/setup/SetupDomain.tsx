import { Alert, Button, FieldError, FieldHint, Input, Label, Skeleton } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { PlanLimitNotice, planLimitOf } from '../../components/PlanLimitNotice';
import { DomainRefusalHelp } from '../../components/TalkToMax';
import { api, ApiError, errorMessage } from '../../lib/api';
import { clearProgress, isEncryptionMissing, ENCRYPTION_MESSAGE, useCfConnections, useStartOAuth } from '../../lib/cloudflare';
import type { ClaimPreviewData } from '../../lib/claim-preview';
import { DOMAIN_PATTERN } from '../wizards/setup/DomainStep';
import { INVALID_DOMAIN_TEXT, domainErrorMessage } from '../../lib/domain-errors';
import { normalizeDomainInput } from '../../lib/domain-input';
import { useDnsHost } from '../../lib/dns-host';
import { dnsFromPreview, dnsFromStatus, HAND_OFF_ENABLED, hostSentence, REVIEW_PATH, rememberFocusDomain, resultLine, setupChoice, type PublicDns } from '../../lib/first-run';
import { keys, useDomainClaims, useDomains } from '../../lib/queries';
import { handoffPath } from '../../lib/handoff';
import { useSession } from '../../lib/session';
import { clearSignupDomainIf, readSignupDomain } from '../../lib/signup-intent';
import type { AddDomainResult, Domain, DomainClaim, OnboardingStatus, PendingDomainResult } from '../../lib/types';
import { setupSeenKey } from '../../lib/workspace';

/** What S4 is about once a domain is entered: a claim still waiting for its proof, or a domain already proven (for example by its Cloudflare zone). */
type Entered = { name: string; claim: DomainClaim; domain?: undefined } | { name: string; domain: Domain; claim?: undefined };

/**
 * S4, one screen after sign-up (hosted): the domain, one line of what public DNS says about it, and how to set it up, by who hosts
 * its DNS. Cloudflare name servers: "Connect Cloudflare" is the only primary (or "Continue with <account>" when a connection
 * already holds the zone). Any other host, or none we can tell: the existing record path, with the provider named. Nothing here
 * writes to DNS; looking a domain up changes nothing.
 *
 * Self-host never shows this screen: its first run is the home-base setup (SetupWizardPage).
 */
export function SetupDomain({ focus }: { focus?: string } = {}) {
	const { me, canWrite, role } = useSession();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const workspace = me?.workspace_id ?? null;
	const agency = me?.whose_email === 'clients';
	const lookingAround = me?.whose_email === 'looking';
	// A domain from the website checker: a prefill the person confirms. It is never added on its own.
	const [checker, setChecker] = useState<string | null>(() => readSignupDomain());
	const [input, setInput] = useState('');
	const [validation, setValidation] = useState('');
	const [entered, setEntered] = useState<Entered | null>(null);
	const claims = useDomainClaims();
	const [removeError, setRemoveError] = useState('');
	const didNotConnect = !!(useLocation().state as { cfDidNotConnect?: boolean } | null)?.cfDidNotConnect;
	const autoChecked = useRef(false);
	const heading = useRef<HTMLHeadingElement>(null);

	// Back on a later visit: the claim made earlier is still here, with its result and choice.
	const waiting = (claims.data ?? []).filter((c) => c.status === 'pending');
	const domains = useDomains();
	useEffect(() => {
		if (entered) return;
		// Someone finishing a hand-off (or "Finish it myself"): the screen opens on that domain, added or still waiting for proof.
		if (focus) {
			const held = (domains.data ?? []).find((d) => d.domain === focus);
			if (held) return setEntered({ name: held.domain, domain: held });
			const claim = waiting.find((c) => c.domain === focus);
			if (claim) return setEntered({ name: claim.domain, claim });
		}
		if (waiting.length === 0) return;
		const first = waiting.find((c) => c.domain === checker) ?? waiting[0]!;
		setEntered({ name: first.domain, claim: first });
	}, [entered, waiting, checker, focus, domains.data]);

	const add = useMutation({
		mutationFn: (domain: string) => api<AddDomainResult | PendingDomainResult>('/api/domains', { method: 'POST', body: { domain } }),
		onSuccess: (res, domain) => {
			clearSignupDomainIf(domain);
			rememberFocusDomain(workspace, domain);
			void qc.invalidateQueries({ queryKey: keys.domains });
			void qc.invalidateQueries({ queryKey: ['auth-status'] });
			void qc.invalidateQueries({ queryKey: ['workspaces'] });
			if ('pending' in res && res.pending) setEntered({ name: domain, claim: res.claim });
			else setEntered({ name: domain, domain: (res as AddDomainResult).domain });
		},
	});

	// The domain is known (the website checker): check it on arrival and show the result. The person is not asked for what we know, and
	// "Not this domain?" is one click away. If it is refused, the field comes back with the reason.
	useEffect(() => {
		if (!checker || entered || autoChecked.current || !canWrite || claims.isPending || domains.isPending || waiting.length > 0 || focus) return;
		if ((domains.data ?? []).some((d) => d.domain === checker)) return;
		autoChecked.current = true;
		add.mutate(checker, {
			onError: () => {
				setInput(checker);
				setChecker(null);
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [checker, entered, canWrite, claims.isPending, domains.isPending, waiting.length, focus]);

	function submit(e: FormEvent, preset?: string) {
		e.preventDefault();
		const d = normalizeDomainInput(preset ?? input);
		if (!d || !DOMAIN_PATTERN.test(d)) return setValidation(INVALID_DOMAIN_TEXT);
		setValidation('');
		add.mutate(d);
	}

	/** "Not this domain?": the claim is removed on the server and from the cache BEFORE the screen clears, so the typo does not come back and does not linger as a pending domain. */
	async function notThisDomain() {
		const claim = entered?.claim;
		setRemoveError('');
		if (claim) {
			try {
				await api(`/api/domains/claims/${claim.id}`, { method: 'DELETE' });
			} catch (e) {
				return setRemoveError(`${errorMessage(e)} ${claim.domain} is still waiting here.`);
			}
			qc.setQueryData<{ domains: Domain[]; pending_claims?: DomainClaim[] }>(keys.domains, (old) => (old ? { ...old, pending_claims: (old.pending_claims ?? []).filter((c) => c.id !== claim.id) } : old));
			qc.removeQueries({ queryKey: ['claim-preview', claim.id] });
		}
		clearSignupDomainIf(entered?.name ?? '');
		autoChecked.current = true;
		setChecker(null);
		setEntered(null);
		setInput('');
		add.reset();
		void qc.invalidateQueries({ queryKey: keys.domains });
		void qc.invalidateQueries({ queryKey: ['workspaces'] });
	}

	const notNow = () => {
		try {
			sessionStorage.setItem(setupSeenKey(workspace ?? ''), '1');
		} catch {
			/* ignore */
		}
		navigate('/');
	};

	const title = entered ? null : agency ? "Add your first client's domain" : 'Which domain do you send email from?';
	const atLimit = add.isError ? planLimitOf(add.error) : null;
	const error = validation || (add.isError && !atLimit ? domainErrorMessage(add.error) : '');
	const field = agency ? "Client's domain" : 'Domain';

	return (
		<div className="mx-auto max-w-xl space-y-6 lg:max-w-5xl" data-testid="setup-domain">
			{!entered ? (
				claims.isPending && !add.isPending ? (
					<Skeleton className="h-40 w-full" role="status" aria-label="Checking for a domain you started with" />
				) : checker ? (
					<div className="space-y-4">
						<h1 ref={heading} className="text-2xl font-semibold tracking-tight">{title}</h1>
						<p className="text-sm text-ink-1">
							Domain: <span className="font-mono [overflow-wrap:anywhere]">{checker}</span> ·{' '}
							<button type="button" className="text-brand-ink underline underline-offset-4" disabled={add.isPending} onClick={() => { clearSignupDomainIf(checker); setChecker(null); }}>
								Not this domain?
							</button>
						</p>
						<Skeleton className="h-5 w-3/4" role="status" aria-label={`Reading public DNS for ${checker}`} />
					</div>
				) : (
					<div className="lg:grid lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-16">
					<form onSubmit={submit} className="space-y-4" noValidate>
						<h1 ref={heading} className="text-2xl font-semibold tracking-tight">{title}</h1>
						<div className="space-y-1.5">
							<Label htmlFor="s4-domain">{field}</Label>
							<Input
								id="s4-domain"
								placeholder="brightwave-mail.com"
								autoFocus
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								value={input}
								onChange={(e) => setInput(e.target.value)}
								aria-describedby={error ? 's4-domain-hint s4-domain-error' : 's4-domain-hint'}
								aria-invalid={error ? true : undefined}
							/>
							<FieldHint id="s4-domain-hint">{agency ? 'Each client gets its own workspace, named after its domain. You can rename it.' : 'Looking it up changes nothing in its DNS.'}</FieldHint>
							{error ? <FieldError id="s4-domain-error">{error}</FieldError> : null}
							{atLimit ? <PlanLimitNotice limit={atLimit} /> : null}
							{add.isError && !atLimit ? <DomainRefusalHelp error={add.error} /> : null}
						</div>
						<Button type="submit" className="w-full sm:w-auto" loading={add.isPending} disabled={!canWrite || !input.trim()}>
							{normalizeDomainInput(input) ? `Check ${normalizeDomainInput(input)}` : 'Check'}
						</Button>
						{agency ? (
							<p className="text-sm">
								<Link to="/bulk-import" className="text-brand-ink underline underline-offset-4">
									Several clients at once? Paste a list of domains
								</Link>
							</p>
						) : null}
					</form>
					{/* Wide screens only: what comes next, so the page is not one narrow column in an empty field. */}
					<aside aria-label="What happens next" className="space-y-3 rounded-lg border border-line bg-surface-1 p-5 text-sm text-ink-2 max-lg:hidden sm:p-6">
						<h2 className="text-base font-semibold text-ink-1">What happens next</h2>
						<ol className="list-decimal space-y-2 pl-5">
							<li>We read the domain's SPF, DKIM and DMARC from public DNS. Nothing in its DNS changes.</li>
							<li>You choose how to set it up, by who hosts its DNS.</li>
							<li>You see every record before anything is written.</li>
						</ol>
					</aside>
					</div>
				)
			) : (
				<Entered entered={entered} removeError={removeError} didNotConnect={didNotConnect} onNotThis={() => void notThisDomain()} onVerified={() => navigate('/')} heading={heading} />
			)}
			<div className="space-y-2 text-sm text-ink-2">
				{lookingAround ? (
					<p>
						<button type="button" className="text-ink-2 underline underline-offset-4 hover:text-ink-1" onClick={notNow}>
							Not now, show me the dashboard
						</button>
					</p>
				) : null}
				{HAND_OFF_ENABLED && entered && role === 'owner' ? (
					<p>
						Not the one setting this up?{' '}
						<Link to={handoffPath(entered.name)} className="text-brand-ink underline underline-offset-4">
							Hand setup to a teammate →
						</Link>
					</p>
				) : null}
			</div>
		</div>
	);
}

/** The result and the choice for the domain just entered. */
function Entered({ entered, removeError, didNotConnect, onNotThis, onVerified, heading }: { entered: Entered; removeError: string; didNotConnect: boolean; onNotThis: () => void; onVerified: () => void; heading: React.RefObject<HTMLHeadingElement | null> }) {
	const { canWrite, me } = useSession();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [manual, setManual] = useState(false);
	const [verifyError, setVerifyError] = useState('');
	const name = entered.name;
	const host = useDnsHost(name);
	const conns = useCfConnections(canWrite);
	const claim = entered.claim;

	// Public DNS, in one line: a claim is read without proof (the preview), a proven domain through its own status.
	const preview = useQuery({ queryKey: ['claim-preview', claim?.id], queryFn: () => api<ClaimPreviewData>(`/api/domains/claims/${claim!.id}/preview`), enabled: !!claim, retry: false, staleTime: 60_000 });
	const status = useQuery({ queryKey: ['onboarding-status', entered.domain?.id], queryFn: () => api<OnboardingStatus>(`/api/domains/${entered.domain!.id}/onboarding-status`), enabled: !claim, retry: false, staleTime: 60_000 });
	const dns: PublicDns | null = claim ? (preview.data ? dnsFromPreview(preview.data) : null) : status.data ? dnsFromStatus(status.data) : null;
	const dnsLoading = claim ? preview.isPending : status.isPending;

	const choice = setupChoice(name, host.data, conns.data, canWrite);
	// Waiting only for the first answers. Once they are in (or failed), a refetch by a card below must not bring the skeleton back: that would unmount the card and start it all again.
	const answered = useRef(false);
	if (!host.isPending && !(canWrite && conns.isPending)) answered.current = true;
	const hostPending = !answered.current;
	const doesNotExist = !!dns?.nxdomain;

	const verify = useMutation({
		mutationFn: () => api<{ domain: Domain }>(`/api/domains/claims/${claim!.id}/verify`, { method: 'POST' }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: keys.domains });
			navigate(REVIEW_PATH);
		},
		onError: (e) => setVerifyError(e instanceof ApiError ? e.message : errorMessage(e)),
	});

	// "Connect Cloudflare" opens Cloudflare's own consent right away (the same server start the Connect screen used: state and PKCE are the server's).
	// Only an instance that offers a pasted token and no sign-in goes to the token screen.
	const start = useStartOAuth();
	const startError = start.isError ? (isEncryptionMissing(start.error) ? ENCRYPTION_MESSAGE : errorMessage(start.error)) : '';
	const connect = () => {
		clearProgress(me?.workspace_id ?? null);
		if (!conns.data?.oauth.available) return navigate('/setup/cloudflare');
		start.mutate({ returnTo: '/#/setup/cloudflare' }, { onSuccess: (r) => window.location.assign(r.authorize_url) });
	};

	return (
		<div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start lg:gap-x-16 lg:gap-y-5 lg:space-y-0" data-testid="s4-columns">
			<div className="space-y-5">
			{/* Focus lands on the headline so a screen reader hears the change. */}
			<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none [overflow-wrap:anywhere]">
				{hostPending || doesNotExist ? name : hostSentence(name, choice, host.data)}
			</h1>
			<p className="text-sm text-ink-1">
				Domain: <span className="font-mono [overflow-wrap:anywhere]">{name}</span>
				{claim ? (
					<>
						{' '}
						·{' '}
						<button type="button" className="text-brand-ink underline underline-offset-4" onClick={onNotThis}>
							Not this domain?
						</button>
					</>
				) : null}
			</p>
			{removeError ? <Alert variant="warning">{removeError}</Alert> : null}
			<div aria-live="polite" data-testid="dns-result">
				{dnsLoading ? <Skeleton className="h-5 w-3/4" role="status" aria-label="Reading public DNS" /> : dns ? <p className="max-w-prose text-base text-ink-1 [overflow-wrap:anywhere]">{resultLine(name, dns)}</p> : <p className="text-sm text-ink-2">We couldn't read public DNS for {name} just now. You can still set it up.</p>}
			</div>

			</div>
			<div className="space-y-5 lg:rounded-lg lg:border lg:border-line lg:bg-surface-1 lg:p-6" data-testid="s4-choice">
			{doesNotExist ? (
				<p className="text-sm">
					<button type="button" className="text-brand-ink underline underline-offset-4" onClick={onNotThis}>
						Use a different domain
					</button>
				</p>
			) : hostPending ? (
				<Skeleton className="h-24 w-full" role="status" aria-label="Checking who hosts DNS" />
			) : !claim ? (
				// Proven already (its Cloudflare zone, or an earlier visit): nothing to prove, so go on.
				<div className="space-y-3">
					{choice.kind === 'continue' ? <p className="max-w-prose text-sm text-ink-2">Cloudflare is already connected for {name}. We prepare the changes; you see every record before anything is written.</p> : <p className="max-w-prose text-sm text-ink-2">{name} is added and watched. Nothing was changed in its DNS.</p>}
					<Button className="w-full sm:w-auto" onClick={() => navigate(choice.kind === 'continue' ? REVIEW_PATH : '/')}>
						{choice.kind === 'continue' ? (choice.account ? `Continue with ${choice.account}` : 'Continue with Cloudflare') : 'Go to the dashboard'}
					</Button>
				</div>
			) : manual || choice.kind === 'records' ? (
				<div className="space-y-3">
					<ClaimCard claim={claim} recordsOnly canWrite={canWrite} onVerified={onVerified} onRemoved={onNotThis} />
				</div>
			) : (
				<div className="space-y-3">
					<p className="max-w-prose text-sm text-ink-2">
						{choice.kind === 'continue'
							? `Cloudflare is connected for ${name}. We prepare the changes; you see every record before anything is written.`
							: "Connect Cloudflare and we'll prepare the changes. You see every record before anything is written."}
					</p>
					{didNotConnect ? <Alert variant="warning" data-testid="cf-did-not-connect">Cloudflare didn't connect, so nothing changed. Try again, or add the records yourself.</Alert> : null}
					{verifyError ? <Alert variant="warning">{verifyError}</Alert> : null}
					{startError ? <FieldError>{startError}</FieldError> : null}
					<div className="flex flex-col gap-2 sm:flex-row">
						{choice.kind === 'continue' ? (
							<Button className="w-full sm:w-auto" loading={verify.isPending} onClick={() => { setVerifyError(''); verify.mutate(); }}>
								{choice.account ? `Continue with ${choice.account}` : 'Continue with Cloudflare'}
							</Button>
						) : (
							<Button className="w-full sm:w-auto" loading={start.isPending} onClick={connect}>
								{start.isPending ? 'Opening Cloudflare…' : 'Connect Cloudflare'}
							</Button>
						)}
						<Button variant="secondary" className="w-full sm:w-auto" onClick={() => setManual(true)}>
							I'll add the records myself
						</Button>
					</div>
				</div>
			)}
			</div>
		</div>
	);
}
