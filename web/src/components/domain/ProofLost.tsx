import { Alert, Button } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useDomainClaims } from '../../lib/queries';
import type { Domain } from '../../lib/types';
import { ClaimCard } from './ClaimCard';

/** A domain this workspace has but can no longer show it controls (a zone proof that lapsed, a parent that left): it is held, not removed. */
export const isUnproven = (d: Pick<Domain, 'verified_via'>): boolean => d.verified_via === 'legacy';

/**
 * "Proof lost: prove it is still yours": the way back after a proof lapsed, on the SAME domain. Prove again re-runs the proof (the zone through any current
 * Cloudflare connection, or the TXT record) and restores the row in place, report history intact. Nothing is removed first. Reports are not accepted while
 * the domain is unproven; the ones stored stay. When the proof needs the TXT record, the claim's card is shown here (its Verify restores the same row).
 */
export function ProofLost({ domain, canWrite }: { domain: Pick<Domain, 'id' | 'domain' | 'proof_lost_at'>; canWrite: boolean }) {
	const qc = useQueryClient();
	const [error, setError] = useState('');
	const claim = (useDomainClaims().data ?? []).find((c) => c.domain === domain.domain && c.status === 'pending');
	const lapsed = domain.proof_lost_at != null;
	const prove = useMutation({
		mutationFn: () => api<{ pending?: boolean }>(`/api/domains/${domain.id}/prove`, { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }), // proven: the block goes; not yet: the claim's TXT record shows in its place
		onError: (e) => setError(errorMessage(e)),
	});
	return (
		<Alert variant="warning" title={lapsed ? 'Proof lost: prove it is still yours' : 'Not proven yet: prove it is yours'} data-testid={`proof-lost-${domain.id}`}>
			<div className="space-y-3">
				<p className="[overflow-wrap:anywhere]">
					<span className="font-mono">{domain.domain}</span>{' '}
					{lapsed
						? "no longer shows the Cloudflare proof it was added with (the zone moved, or its name servers changed)."
						: 'was never proven in this workspace.'}{' '}
					Reports for this domain are not accepted until it is proven again. What is stored stays, and nothing is removed.
				</p>
				{claim ? (
					<ClaimCard claim={claim} canWrite={canWrite} />
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<Button loading={prove.isPending} disabled={!canWrite} onClick={() => { setError(''); prove.mutate(); }}>
							Prove again
						</Button>
						<span className="text-sm text-ink-2">Checks your Cloudflare connections, then the TXT record. Your report history stays.</span>
					</div>
				)}
				{error ? <p role="alert" className="text-sm [overflow-wrap:anywhere]">{error}</p> : null}
			</div>
		</Alert>
	);
}

/** The unproven domains, each with its way back: first on the overview, above everything that waits for something else. */
export function ProofLostList({ domains, canWrite }: { domains: Domain[]; canWrite: boolean }) {
	const lost = domains.filter(isUnproven);
	if (lost.length === 0) return null;
	return (
		<section aria-label="Domains that need proving again" className="space-y-3">
			{lost.map((d) => (
				<ProofLost key={d.id} domain={d} canWrite={canWrite} />
			))}
		</section>
	);
}
