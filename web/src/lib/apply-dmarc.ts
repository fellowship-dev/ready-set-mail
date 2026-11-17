import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { invalidateDomain } from './domain-queries';

/** What POST /api/domains/:id/apply-dmarc answers (src/api/router.ts). */
export interface ApplyDmarcResponse {
	ok: boolean;
	record: string;
	created: boolean;
}

/**
 * How the dashboard writes a policy record the person chose through Cloudflare: POST /api/domains/:id/apply-dmarc with the record to publish
 * (self-host, the setup wizard, DNS records). On the hosted service the server refuses a record that adds our report address or drops a
 * published one: our address is written only by Connect reports (`useReportAddressMutations().apply`, ADR 0020). Whatever the outcome,
 * everything cached for the domain is read again.
 */
export function useApplyDmarc(domainId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (record: string | null) => api<ApplyDmarcResponse>(`/api/domains/${domainId}/apply-dmarc`, { method: 'POST', body: { record } }),
		onSettled: () => invalidateDomain(qc, domainId),
	});
}
