import { useCfConnections, usableConnection } from '../../lib/cloudflare';
import { hostOf, isCloudflareHost, safeHelpUrl, useDnsHost } from '../../lib/dns-host';
import { useSession } from '../../lib/session';

/**
 * One line above records to copy: where this domain's DNS is hosted, so the person knows where to paste them.
 * Nothing while loading or when we could not tell, and nothing when DNS is at Cloudflare and Cloudflare is connected (we write the records).
 */
export function DnsHostLine({ domain, className }: { domain: string; className?: string }) {
	const { canWrite } = useSession();
	const host = useDnsHost(domain);
	const conns = useCfConnections(canWrite);
	const provider = hostOf(host.data);
	if (!provider) return null;
	if (isCloudflareHost(provider) && usableConnection(conns.data)) return null;
	const help = safeHelpUrl(provider);
	return (
		<p className={className ?? 'text-sm text-ink-2'}>
			Add these at {provider.name}, where {domain}'s DNS is hosted.
			{help ? (
				<>
					{' '}
					<a href={help} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline underline-offset-4">
						How to add a TXT record at {provider.name}
					</a>
				</>
			) : null}
		</p>
	);
}
