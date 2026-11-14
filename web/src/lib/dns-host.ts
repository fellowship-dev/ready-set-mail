import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** GET /api/domains/dns-host?name=: who hosts a domain's DNS, read from its public nameservers (src/domains/dns-host*.ts). */
export interface DnsHostProvider {
	id: string;
	name: string;
	help_url?: string;
	/** What the provider's host/name field wants: the short host (`_dmarc`), the full name, or either. */
	host_field?: 'relative' | 'fqdn' | 'either';
	/** The provider adds the domain to what is typed in the host field. */
	appends_domain?: boolean;
}

export interface DnsHost {
	provider: DnsHostProvider | null;
	nameservers: string[];
	/** Only `known` carries a provider we may name. `mixed`, `unknown` and `error` are all "we could not tell". */
	status: 'known' | 'unknown' | 'mixed' | 'error';
	providers?: Array<{ id: string; name: string }>;
}

export const dnsHostKey = (name: string) => ['dns-host', name] as const;

/**
 * Who hosts DNS for `name`. Read after first paint (a screen never waits on it), never retried, open to members and admins alike.
 * An error is an answer too: callers see `hostOf` return null, the same as unknown.
 */
export function useDnsHost(name: string, enabled = true) {
	return useQuery({
		queryKey: dnsHostKey(name),
		queryFn: () => api<DnsHost>(`/api/domains/dns-host?name=${encodeURIComponent(name)}`),
		enabled: enabled && name !== '',
		retry: false,
		staleTime: 5 * 60_000,
	});
}

/** The provider to name, or null for loading, unknown, mixed and error. */
export function hostOf(data: DnsHost | undefined): DnsHostProvider | null {
	return data && data.status === 'known' && data.provider ? data.provider : null;
}

/** A help link only when it is a real web address. */
export function safeHelpUrl(p: DnsHostProvider | null): string | null {
	if (!p?.help_url) return null;
	try {
		const u = new URL(p.help_url);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
	} catch {
		return null;
	}
}

export const isCloudflareHost = (p: DnsHostProvider | null) => p?.id === 'cloudflare';
