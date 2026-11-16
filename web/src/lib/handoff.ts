/** Hand setup to a teammate (spec H1, H2, I1), as the dashboard sees it. The server side is src/team/handoff.ts. */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { POLL_FAST_MS } from './poll';

export interface HandoffStatus {
	id: string;
	email: string;
	domain: string;
	/** Unix seconds. */
	sent_at: number;
	/** The link works until this. */
	expires_at: number;
	/** When the teammate joined; null until then. */
	joined_at: number | null;
	/** False when we did not email it: the inviter was given the link to send. */
	emailed: boolean;
}

export const handoffKeys = { list: ['team-handoffs'] as const };

/**
 * Hand-offs of this workspace. Owners and admins only; elsewhere the request is skipped. While a link is still waiting to be used the list is
 * looked at again every 15 seconds (a hidden tab does not look) and whenever the tab is focused, so an owner who leaves the dashboard open sees
 * "<email> joined" without a reload.
 */
export function useHandoffs(enabled: boolean) {
	return useQuery({
		queryKey: handoffKeys.list,
		queryFn: () => api<{ handoffs: HandoffStatus[] }>('/api/team/handoffs').then((r) => r.handoffs),
		enabled,
		retry: false,
		staleTime: 30_000,
		refetchOnWindowFocus: 'always',
		refetchInterval: (q) => (q.state.data?.some((h) => !h.joined_at && h.expires_at * 1000 > Date.now()) ? POLL_FAST_MS : false),
	});
}

/** The page where a hand-off is made, for a domain. */
export const handoffPath = (domain: string) => `/setup/hand-off?domain=${encodeURIComponent(domain)}`;
/** The first screen of a domain's setup (S4), for someone who joined to finish it. */
export const setupPathFor = (domain: string) => `/setup?domain=${encodeURIComponent(domain)}`;
