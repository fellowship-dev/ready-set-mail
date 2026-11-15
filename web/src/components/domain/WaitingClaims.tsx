import type { DomainClaim } from '../../lib/types';
import { ClaimCard } from './ClaimCard';

/** Domains that wait for proof of ownership. First on the overview: nothing below it moves until they are proven. */
export function WaitingClaims({ claims, canWrite }: { claims: DomainClaim[]; canWrite: boolean }) {
	if (claims.length === 0) return null;
	return (
		<section aria-labelledby="waiting-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="waiting-heading" className="text-lg font-semibold tracking-tight">
					Waiting for verification
				</h2>
				<p className="text-sm text-ink-2">
					{/* Both modes show a live DNS preview on these cards, so "not monitored" must not read as "nothing to see". */}
					Prove you own each one with a DNS record. Until then a domain is not monitored: there are no stored checks, stats or alerts, only a live look at its DNS.
				</p>
			</div>
			{claims.map((c) => (
				<ClaimCard key={c.id} claim={c} canWrite={canWrite} preview="lazy" />
			))}
		</section>
	);
}
