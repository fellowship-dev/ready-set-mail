import { Button } from '@ready-set-mail/ui';
import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { useQuery } from '@tanstack/react-query';
import { Check, Clock } from 'lucide-react';
import { fetchDnsState } from '../../lib/cloudflare';

/** Two DMARC records are the same when every tag matches, names and values compared without letter case or spaces (rua= as a set). */
export function sameRecord(a: string | null | undefined, b: string | null | undefined): boolean {
	const norm = (r: string | null | undefined) =>
		decodeTxtData(r ?? '')
			.split(';')
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => {
				const i = t.indexOf('=');
				const k = (i < 0 ? t : t.slice(0, i)).trim().toLowerCase();
				const v = (i < 0 ? '' : t.slice(i + 1)).replace(/\s+/g, '').toLowerCase();
				return `${k}=${k === 'rua' || k === 'ruf' ? v.split(',').filter(Boolean).sort().join(',') : v}`;
			})
			.sort()
			.join(';');
	return !!a && !!b && norm(a) === norm(b);
}

/** Re-reads public DNS (the DNS-over-HTTPS check, `dns-state`) every few seconds until it shows the record that was written, for about five minutes. */
export function usePublicDmarc(domain: string, written: string) {
	const q = useQuery({
		queryKey: ['public-dmarc', domain, written],
		queryFn: async () => (await fetchDnsState([domain]))[0]?.dmarc.record ?? null,
		refetchInterval: (query) => (sameRecord(query.state.data, written) || query.state.dataUpdateCount >= 40 ? false : 7_000),
		retry: false,
	});
	return { live: sameRecord(q.data, written), checking: q.isFetching, recheck: () => void q.refetch() };
}

/**
 * Whether a DMARC record the product wrote is in public DNS yet. It is said to be live only after a re-read of public DNS shows it; until
 * then the record was written, and is waiting to show.
 */
export function PublicDnsLive({ domain, record, label }: { domain: string; record: string; label?: string }) {
	const { live, checking, recheck } = usePublicDmarc(domain, record);
	return live ? (
		<p className="flex items-start gap-1 text-sm text-success">
			<Check aria-hidden className="mt-0.5 size-4 shrink-0" />
			<span>{label ? `${label}: ` : ''}Live in public DNS.</span>
		</p>
	) : (
		<p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
			<Clock aria-hidden className="size-4 shrink-0" />
			<span>{label ? `${label}: ` : ''}Written to Cloudflare. Waiting to show in public DNS.</span>
			<Button variant="ghost" size="sm" onClick={recheck} disabled={checking}>
				{checking ? 'Checking…' : 'Check again'}
			</Button>
		</p>
	);
}
