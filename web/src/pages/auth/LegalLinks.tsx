import { useHelpUrl, useSession } from '../../lib/session';
import { TALK_TO_MAX_TITLE } from '../../components/TalkToMax';

/** What GET /api/auth/status says about terms, privacy and the operator (src/auth/legal.ts). */
export interface LegalInfo {
	terms_url: string | null;
	privacy_url: string | null;
	operator_name: string | null;
}

/** The legal part of the status, when the server sends it. */
export function useLegal(): LegalInfo | null {
	const { status } = useSession();
	const legal = (status as { legal?: LegalInfo } | null | undefined)?.legal;
	return legal ?? null;
}

const link = 'text-ink-2 underline underline-offset-4 hover:text-ink-1';

/** Terms · Privacy · Talk to Max, small and quiet. Hosted only (a self-hosted instance is its operator's to label). */
export function LegalLinks({ className }: { className?: string }) {
	const { status } = useSession();
	const legal = useLegal();
	const help = useHelpUrl();
	if (status?.mode !== 'saas') return null;
	const items = [
		legal?.terms_url ? <a key="terms" className={link} href={legal.terms_url} target="_blank" rel="noopener noreferrer">Terms</a> : null,
		legal?.privacy_url ? <a key="privacy" className={link} href={legal.privacy_url} target="_blank" rel="noopener noreferrer">Privacy</a> : null,
		help ? <a key="help" className={link} href={help} target="_blank" rel="noopener noreferrer" title={TALK_TO_MAX_TITLE}>Talk to Max</a> : null,
	].filter(Boolean);
	if (items.length === 0) return null;
	return (
		<nav aria-label="Legal and help" className={className}>
			<ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
				{items.map((item, i) => (
					<li key={i}>{item}</li>
				))}
			</ul>
		</nav>
	);
}

/** "By creating an account you agree to the Terms and the Privacy Policy.", when this instance has both pages. */
export function TermsAgreement() {
	const legal = useLegal();
	if (!legal?.terms_url || !legal.privacy_url) return null;
	return (
		<p className="text-xs text-ink-2">
			By creating an account you agree to the{' '}
			<a className="underline underline-offset-4 hover:text-ink-1" href={legal.terms_url} target="_blank" rel="noopener noreferrer">Terms</a> and the{' '}
			<a className="underline underline-offset-4 hover:text-ink-1" href={legal.privacy_url} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
		</p>
	);
}
