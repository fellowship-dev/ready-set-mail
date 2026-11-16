import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Domain, DomainClaim } from './types';

export const keys = {
	domains: ['domains'] as const,
	domain: (id: number) => ['domain', id] as const,
};

interface DomainList {
	domains: Domain[];
	/** SaaS only; absent or empty on self-host. */
	pending_claims?: DomainClaim[];
	/** Hosted: the domain S4 was given, as the server holds it (null when none, or on self-host). */
	first_run_domain?: string | null;
}

const fetchDomains = () => api<DomainList>('/api/domains');

/** Verified domains only (what reports, stats and DNS exist for). */
export function useDomains() {
	return useQuery({ queryKey: keys.domains, queryFn: fetchDomains, select: (r) => r.domains });
}

/** The domain the first run is about, from the server: the same in every browser. */
export function useFirstRunDomain() {
	return useQuery({ queryKey: keys.domains, queryFn: fetchDomains, select: (r) => r.first_run_domain ?? null });
}

/** Claims waiting for a DNS proof (or lost to another workspace). Empty on self-host. */
export function useDomainClaims() {
	return useQuery({ queryKey: keys.domains, queryFn: fetchDomains, select: (r) => r.pending_claims ?? [] });
}

/** One domain from the list (there is no GET /api/domains/:id). `domain` is undefined while loading or if it does not exist. */
export function useDomain(id: number) {
	const q = useDomains();
	return { ...q, domain: q.data?.find((d) => d.id === id) };
}
