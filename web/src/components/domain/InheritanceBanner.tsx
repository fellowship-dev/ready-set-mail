import { Alert } from '@ready-set-mail/ui';
import type { ParentContext } from '../../lib/types';

/**
 * What a new subdomain inherits from its parent: SPF and DKIM do not inherit. What DMARC policy applies, and what it
 * does to mail, is said once above, from the live read in the shared rule's words (inheritedSentence): this banner makes
 * no claim of its own about it.
 */
export function InheritanceBanner({ pc, subdomain }: { pc: ParentContext; subdomain: string }) {
	return (
		<section className="space-y-3" aria-label="Subdomain inheritance">
			<h2 className="text-lg font-semibold tracking-tight">
				Subdomain of <span className="font-mono">{pc.domain}</span>: inheritance summary
			</h2>
			{!pc.has_dmarc ? (
				<Alert variant="warning" title="DMARC: parent has no record">
					No DMARC record found on {pc.domain}. Consider setting up {pc.domain} first, then return here.
				</Alert>
			) : null}
			<Alert variant="info" title="SPF does not inherit">
				{subdomain} needs its own SPF record.
			</Alert>
			<Alert variant="info" title="DKIM does not inherit">
				Check with your email provider for subdomain signing setup.
			</Alert>
		</section>
	);
}
