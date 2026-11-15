// The "create a token" link Cloudflare documents for user tokens:
// https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// Only documented parts are used: the short keys `zone`, `dns` and `account_settings`, the types `read` / `edit` (a user token
// takes `edit`, not `write`), `accountId=*` and `zoneId=all`. There is no documented key for Email Routing, and Cloudflare drops
// unknown keys without a notice, so those permissions are never put in the link; the screen tells the owner to add them by hand.
const BASE = 'https://dash.cloudflare.com/profile/api-tokens';

export interface TokenPermission { key: string; type: 'read' | 'edit' }

export function tokenPermissions(hosted: boolean): TokenPermission[] {
	const base: TokenPermission[] = [
		{ key: 'zone', type: 'read' },
		{ key: 'dns', type: 'edit' },
	];
	return hosted ? base : [...base, { key: 'account_settings', type: 'read' }];
}

export function tokenLink(hosted: boolean): string {
	const keys = encodeURIComponent(JSON.stringify(tokenPermissions(hosted)));
	return `${BASE}?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=${encodeURIComponent('Ready Set Mail')}`;
}
