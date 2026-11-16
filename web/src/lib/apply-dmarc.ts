import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { invalidateDomain } from './domain-queries';

/** What POST /api/domains/:id/apply-dmarc answers (src/api/router.ts). `reports`: what the write did about the domain's reports (hosted). */
export interface ApplyDmarcResponse {
	ok: boolean;
	record: string;
	created: boolean;
	reports?: { state: 'connected' | 'limit' | 'refused' | 'unavailable'; address?: string; reason?: string };
}

/**
 * The one way the dashboard writes a DMARC record through Cloudflare: POST /api/domains/:id/apply-dmarc with the record to publish. On
 * the hosted service the server connects the domain's reports before it writes a record that carries our address. Whatever the outcome,
 * everything cached for the domain is read again (a failed write can still have connected the reports).
 */
export function useApplyDmarc(domainId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (record: string | null) => api<ApplyDmarcResponse>(`/api/domains/${domainId}/apply-dmarc`, { method: 'POST', body: { record } }),
		onSettled: () => invalidateDomain(qc, domainId),
	});
}
