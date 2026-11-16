/**
 * What a link from the website says about the visit that led to sign-up, for the hosted dashboard's product analytics
 * (docs/analytics.md). Read once from the sign-up link (`/signup?domain=…&vid=…&from=…`) by captureSignupIntent and kept in this
 * module's memory only: never in a cookie, localStorage or sessionStorage, so a reload or a new tab forgets it. It is sent with the
 * sign-up form and nothing else; the server accepts `vid` only as a canonical UUID and `entry` only from a fixed list.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENTRIES = ['checker', 'report', 'agencies', 'header', 'pricing'] as const;

let visit: { vid?: string; entry: string } | null = null;

/** Remember the visit a sign-up link describes (called before the app renders, with the link's query). */
export function captureVisit(params: URLSearchParams): void {
	const vid = params.get('vid');
	const from = params.get('from');
	const entry = from && (ENTRIES as readonly string[]).includes(from) ? from : params.get('domain') ? 'checker' : 'cold';
	visit = { ...(vid && UUID.test(vid) ? { vid } : {}), entry };
}

/** The fields the sign-up form adds to its request: `{}` when the person did not arrive by a sign-up link. */
export function signupAnalytics(): { vid?: string; entry?: string } {
	return visit ? { ...visit } : {};
}

/** Tests only. */
export function __resetVisitForTests(): void {
	visit = null;
}
