import { ApiError } from './api';

export const INVALID_DOMAIN_TEXT = 'Enter a domain like yourdomain.com, without https:// or a path.';
export const DOMAIN_TAKEN_TEXT = 'This domain is already in another workspace. Use a different domain, or ask for access if it is yours.';

/**
 * Plain words for the two refusals the domain endpoints send as bare sentences (status 400 / 409, no code; the API text stays
 * stable for scripts). Anything else keeps the server's own message.
 */
export function domainErrorMessage(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 400 && /^invalid domain format$/i.test(e.message)) return INVALID_DOMAIN_TEXT;
		if (e.status === 409 && /already registered in another workspace/i.test(e.message)) return DOMAIN_TAKEN_TEXT;
	}
	return e instanceof Error ? e.message : 'Something went wrong.';
}
