import { Link, useLocation } from 'react-router';
import { connectCloudflarePath } from '../lib/cloudflare';
import { useSession } from '../lib/session';

/**
 * "Cloudflare is not connected" turned into a way forward: a quiet text link to the two-step connect page,
 * which returns here. Owners and admins only; for everyone else the page could not do anything.
 */
export function ConnectCloudflareLink({ className, children }: { className?: string; children?: string }) {
	const { canWrite } = useSession();
	const { pathname, search } = useLocation();
	if (!canWrite) return null;
	return (
		<p className={className ?? 'text-sm'}>
			<Link to={connectCloudflarePath(pathname, search)} className="text-brand-ink underline underline-offset-4">
				{children ?? 'Connect Cloudflare to write this for you'}
			</Link>
		</p>
	);
}
