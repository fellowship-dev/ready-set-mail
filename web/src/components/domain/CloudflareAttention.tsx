import { Alert } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { activeConnection, useCfConnections, useCfSuggestions } from '../../lib/cloudflare';
import { useHosted, useSession } from '../../lib/session';

/**
 * What blocks Cloudflare from working, and what is waiting in the connected accounts, as one quiet block at the top of the overview.
 * Nothing for people who cannot connect Cloudflare, or when everything is fine.
 */
export function CloudflareAttention({ hideBroken = false }: { /** The first-day card already says it in one line. */ hideBroken?: boolean } = {}) {
	const { canWrite } = useSession();
	const hosted = useHosted();
	const conns = useCfConnections(canWrite);
	const working = !!conns.data && activeConnection(conns.data) !== null;
	const suggestions = useCfSuggestions(canWrite && hosted && working);
	if (!canWrite || !conns.data) return null;
	const broken = conns.data.connections.filter((c) => !c.implicit && c.status !== 'active');
	const fresh = (suggestions.data ?? []).filter((s) => !s.removed);
	if ((broken.length === 0 || hideBroken) && fresh.length === 0) return null;
	return (
		<div className="space-y-3">
			{broken.length > 0 && !hideBroken ? (
				<Alert variant="warning" title="Cloudflare needs to be reconnected">
					<span>
						{broken.length === 1 ? broken[0]!.label : `${broken.length} connections`} can no longer reach Cloudflare. Your domains stay verified and watched; changing their DNS needs a reconnect.{' '}
						<Link to="/settings" className="underline underline-offset-4">
							Reconnect in Settings
						</Link>
					</span>
				</Alert>
			) : null}
			{fresh.length > 0 ? (
				<p className="text-sm text-ink-2">
					{fresh.length} new {fresh.length === 1 ? 'domain' : 'domains'} in your Cloudflare account:{' '}
					<Link to="/add" className="text-brand-ink underline underline-offset-4">
						Add
					</Link>
				</p>
			) : null}
		</div>
	);
}
