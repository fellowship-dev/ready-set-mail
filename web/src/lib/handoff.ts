/** Hand setup to a teammate (spec H1, H2, I1), as the dashboard sees it. The server side is src/team/handoff.ts. */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

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

/** Hand-offs of this workspace. Owners and admins only; elsewhere the request is skipped. */
export function useHandoffs(enabled: boolean) {
	return useQuery({ queryKey: handoffKeys.list, queryFn: () => api<{ handoffs: HandoffStatus[] }>('/api/team/handoffs').then((r) => r.handoffs), enabled, retry: false, staleTime: 30_000 });
}

/** The page where a hand-off is made, for a domain. */
export const handoffPath = (domain: string) => `/setup/hand-off?domain=${encodeURIComponent(domain)}`;
/** The first screen of a domain's setup (S4), for someone who joined to finish it. */
export const setupPathFor = (domain: string) => `/setup?domain=${encodeURIComponent(domain)}`;
