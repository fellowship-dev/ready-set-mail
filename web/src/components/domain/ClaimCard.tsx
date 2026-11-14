import { Alert, Badge, Button } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { Domain, DomainClaim } from '../../lib/types';
import { HELP_PRIORITY, TalkToMax } from '../TalkToMax';
import { PlanLimitNotice, planLimitOf, type PlanLimit } from '../PlanLimitNotice';
import { useCfConnections } from '../../lib/cloudflare';
import { hostOf, isCloudflareHost, safeHelpUrl, useDnsHost, type DnsHostProvider } from '../../lib/dns-host';
import { useSession } from '../../lib/session';
import { ClaimPreview } from './ClaimPreview';
import { ProofRecord } from './ProofRecord';

/** The short host of the proof record (`_readysetmail`): what a provider that adds the domain itself wants typed. */
const shortHost = (txtName: string, domain: string) => (txtName.endsWith(`.${domain}`) ? txtName.slice(0, -(domain.length + 1)) : txtName);

/** The Name rows: the provider's own field when we know it, otherwise both forms. */
function nameRows(provider: DnsHostProvider | null, claim: DomainClaim): Array<{ label: string; value: string }> {
	const short = { label: 'Host', value: shortHost(claim.txt_name, claim.domain) };
	const full = { label: 'Name', value: claim.txt_name };
	const field = provider?.host_field ?? (provider?.appends_domain ? 'relative' : undefined);
	if (field === 'relative') return [short];
	if (field === 'fqdn') return [full];
	return [short, full];
}

export const LOST_EXPLANATION = 'Another workspace verified this domain first, so it cannot be added to this one.';

/** The record is not visible in public DNS yet: nothing is wrong, DNS takes a while. */
export const NOT_VISIBLE_YET = "We don't see the record yet. DNS changes can take a few minutes to show up. Verify again in a minute.";

/** The server's 422 says the record is simply not visible yet (as opposed to a lookup that failed or another refusal). */
const notVisibleYet = (e: unknown): boolean => e instanceof ApiError && e.status === 422 && (e.body as { code?: string } | undefined)?.code === 'not_found_yet';

/** What the server said when the TXT record was not (yet) found: its reason, else the claim's last error. */
function verifyFailure(e: unknown): string {
	if (notVisibleYet(e)) return NOT_VISIBLE_YET;
	if (e instanceof ApiError) {
		const claim = (e.body as { claim?: { last_error?: string | null } } | undefined)?.claim;
		return claim?.last_error && claim.last_error !== e.message ? `${e.message} ${claim.last_error}` : e.message;
	}
	return errorMessage(e);
}

/**
 * A domain that is not ours to monitor yet: add this TXT record to prove ownership, then Verify.
 * `pending` has no reports, stats or DNS: only the claim exists. `lost` can only be removed.
 */
export function ClaimCard({ claim, onVerified, onRemoved, canWrite = true, preview }: { claim: DomainClaim; onVerified?: (domain: Domain, info: { resumed: boolean }) => void; onRemoved?: () => void; canWrite?: boolean; /** Show what public DNS says about the domain: `true` loads it now, `'lazy'` waits for a click. */ preview?: boolean | 'lazy' }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { pathname, search } = useLocation();
	const [error, setError] = useState('');
	/** Failed Verify presses on this card: after two, a person is offered. */
	const [failures, setFailures] = useState(0);
	/** The last press found nothing yet: the button offers to check again. Not a lockout: Verify can be pressed any time. */
	const [waiting, setWaiting] = useState(false);
	const [limit, setLimit] = useState<PlanLimit | null>(null);
	const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });

	const verify = useMutation({
		mutationFn: () => api<{ domain: Domain; resumed?: boolean }>(`/api/domains/claims/${claim.id}/verify`, { method: 'POST' }),
		onSuccess: async (res) => {
			await refresh();
			// `resumed`: the workspace already had the domain, so this press verified nothing new.
			if (onVerified) onVerified(res.domain, { resumed: res.resumed === true });
			else navigate(`/domains/${res.domain.id}`);
		},
		onError: (e) => {
			const atLimit = planLimitOf(e);
			if (atLimit) return setLimit(atLimit);
			setError(verifyFailure(e));
			setWaiting(notVisibleYet(e));
			setFailures((n) => n + 1);
			if (e instanceof ApiError && e.status === 409) void refresh();
		},
	});
	const remove = useMutation({
		mutationFn: () => api(`/api/domains/claims/${claim.id}`, { method: 'DELETE' }),
		onSuccess: async () => {
			await refresh();
			onRemoved?.();
		},
		onError: (e) => setError(errorMessage(e)),
	});
	const lost = claim.status === 'lost';
	// A Cloudflare connection that manages the domain's zone proves ownership by itself (Verify checks it): offer it before the TXT record.
	const session = useSession();
	const conns = useCfConnections(session.canWrite && canWrite && !lost);
	const canConnect = !lost && session.canWrite && canWrite && !!conns.data && (conns.data.oauth.available || conns.data.token_paste);
	// Who hosts DNS: asked after first paint. While it loads, and when it cannot be told (unknown, mixed, error), the generic record shows.
	const dnsHost = useDnsHost(claim.domain, !lost);
	const provider = hostOf(dnsHost.data);
	const onCloudflare = isCloudflareHost(provider);
	// An active connection whose allowed zone contains the domain: the server accepts that as proof, so Verify needs no record.
	const covering = onCloudflare && (conns.data?.connections ?? []).some((c) => c.status === 'active' && c.zones.some((z) => claim.domain === z.name || claim.domain.endsWith(`.${z.name}`)));
	const cloudflareFirst = !lost && onCloudflare && (covering || canConnect);
	/** "I'll add it myself": the record, for someone who would rather not connect Cloudflare. */
	const [manual, setManual] = useState(false);
	const showRecord = !lost && (!cloudflareFirst || manual);
	const connectPrimary = cloudflareFirst && !covering && !manual;
	const helpUrl = onCloudflare ? null : safeHelpUrl(provider);
	const unknownHost = !dnsHost.isPending && !provider;
	const rows = nameRows(provider, claim);
	const connect = () => navigate(`/cloudflare/connect?back=${encodeURIComponent(pathname + search)}`);

	return (
		<div className="space-y-4 rounded-lg border border-line p-4 max-sm:space-y-2 max-sm:border-0 max-sm:p-0" data-testid={`claim-${claim.id}`}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-mono text-base font-semibold [overflow-wrap:anywhere] max-sm:sr-only">{claim.domain}</h3>
				<Badge variant={lost ? 'danger' : 'warning'}>{lost ? 'Claimed elsewhere' : 'Waiting for verification'}</Badge>
			</div>
			{lost ? (
				<>
					<Alert variant="warning">{LOST_EXPLANATION}</Alert>
					<TalkToMax priority={HELP_PRIORITY.claimStuck} lead="Is it yours?" about="about getting access to it" />
				</>
			) : (
				<>
					{cloudflareFirst ? (
						<p className="text-sm text-ink-1">{covering ? `Cloudflare is connected for ${claim.domain}. Verify to prove you control it.` : `${claim.domain} uses Cloudflare for DNS. Connect Cloudflare and we add the record and verify for you`}</p>
					) : provider ? (
						<p className="text-sm text-ink-1">{`${claim.domain}'s DNS is hosted at ${provider.name}. Add this record there to show you control the domain`}</p>
					) : (
						<>
							<p className="text-sm text-ink-1">Prove you control {claim.domain} by adding this DNS record</p>
							{unknownHost ? <p className="text-sm text-ink-2">We couldn't tell who hosts DNS for {claim.domain}.</p> : null}
						</>
					)}
					{showRecord ? (
						<ProofRecord names={rows} value={claim.txt_value}>
							{provider && !cloudflareFirst && rows.length > 1 ? <p className="text-xs text-ink-2">If {provider.name} adds the domain for you, use the short one.</p> : null}
							{helpUrl ? (
								<p className="text-sm">
									<a href={helpUrl} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline underline-offset-4">
										How to add a TXT record at {provider?.name}
									</a>
								</p>
							) : null}
						</ProofRecord>
					) : null}
					{claim.last_error && !error && showRecord ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">Last check: {/ not found yet /.test(claim.last_error) ? 'the record was not visible yet.' : claim.last_error}</p> : null}
				</>
			)}
			{limit ? <PlanLimitNotice limit={limit} /> : null}
			{error ? (
				<Alert variant={waiting ? 'info' : 'warning'} role="alert">
					<span className="[overflow-wrap:anywhere]">{error}</span>
				</Alert>
			) : null}
			{!lost && failures >= 2 ? <TalkToMax priority={HELP_PRIORITY.claimStuck} lead="Added the record and it still does not verify?" about={`about ${claim.domain}`} /> : null}
			<div className="flex flex-wrap gap-2">
				{connectPrimary ? <Button disabled={!canWrite} onClick={connect}>Connect Cloudflare</Button> : null}
				{!lost && !connectPrimary ? (
					<Button loading={verify.isPending} disabled={!canWrite} onClick={() => { setError(''); setLimit(null); verify.mutate(); }}>
						{waiting ? 'Verify again' : 'Verify'}
					</Button>
				) : null}
				{!lost && cloudflareFirst && !manual ? (
					<Button variant="secondary" onClick={() => setManual(true)}>
						I'll add it myself
					</Button>
				) : null}
				{!lost && cloudflareFirst && !covering && manual ? (
					<Button variant="secondary" onClick={connect}>
						Connect Cloudflare
					</Button>
				) : null}
				<Button variant="secondary" loading={remove.isPending} disabled={!canWrite} aria-label={`Remove ${claim.domain}`} onClick={() => { setError(''); remove.mutate(); }}>
					Remove
				</Button>
			</div>
			{!lost && !connectPrimary ? <p className="text-sm text-ink-2">{showRecord ? 'Usually a minute or two.' : 'Usually a few seconds.'}</p> : null}
			{!lost && preview ? <ClaimPreview claimId={claim.id} domain={claim.domain} lazy={preview === 'lazy'} compact /> : null}
		</div>
	);
}
