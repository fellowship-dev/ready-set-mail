/**
 * Where a sign-up came from, for the hosted dashboard's product analytics (docs/analytics.md): the website's sign-up link says
 * `src=<page class>` (home, checker, report, agencies, pricing, errors, tools, other) and, from the checker, `domain=<the checked
 * domain>`. Read once from that link by captureSignupIntent and kept in this module's memory only: never in a cookie, localStorage
 * or sessionStorage, so a reload or a new tab forgets it. The sign-up form sends `src` and `from_checker` (a boolean: the domain
 * itself is never sent for analytics); the server keeps `src` only from its closed list (anything else is `other`, none is `cold`).
 * No id of any kind is read from the link: the server mints the analytics id.
 */
let visit: { src?: string; from_checker: boolean } | null = null;

/** Remember what a sign-up link says (called before the app renders, with the link's query). */
export function captureVisit(params: URLSearchParams): void {
	const src = params.get('src');
	visit = { ...(src ? { src: /^[a-z]{1,20}$/.test(src) ? src : 'other' } : {}), from_checker: !!params.get('domain') };
}

/** The fields the sign-up form adds to its request: `{}` when the person did not arrive by a sign-up link. */
export function signupAnalytics(): { src?: string; from_checker?: boolean } {
	return visit ? { ...visit } : {};
}

/** Tests only. */
export function __resetVisitForTests(): void {
	visit = null;
}
