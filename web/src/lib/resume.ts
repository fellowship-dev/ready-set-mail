// An app sent the person to /oauth/authorize while they were signed out. The server's page links here with `?continue=<that request>`; the dashboard
// keeps it for the tab, and once the person is signed in with a workspace it sends them back to the request, so they see the approval page and not the dashboard.
// Only this server's own authorization endpoint is ever a target: a link that carries anything else is ignored, so it cannot send a person anywhere else.
const KEY = 'rsm.resume';
const MAX_LENGTH = 4000;

/** The path and query of an authorization request, or null for anything else. */
export function safeResumePath(value: string | null | undefined, origin = window.location.origin): string | null {
	if (!value || value.length > MAX_LENGTH || !value.startsWith('/oauth/authorize?')) return null;
	try {
		const url = new URL(value, origin);
		return url.origin === origin && url.pathname === '/oauth/authorize' && !url.hash ? `${url.pathname}${url.search}` : null;
	} catch {
		return null;
	}
}

/** Keep `?continue=` from the address, and take it out of the address bar. */
export function captureResume(): void {
	const params = new URLSearchParams(window.location.search);
	if (!params.has('continue')) return;
	const path = safeResumePath(params.get('continue'));
	try {
		if (path) sessionStorage.setItem(KEY, path);
	} catch {
		/* storage unavailable: the person starts again from the app */
	}
	params.delete('continue');
	const rest = params.toString();
	window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
}

/** The kept request, once; it is forgotten as it is read. */
export function takeResume(): string | null {
	try {
		const path = safeResumePath(sessionStorage.getItem(KEY));
		sessionStorage.removeItem(KEY);
		return path;
	} catch {
		return null;
	}
}
