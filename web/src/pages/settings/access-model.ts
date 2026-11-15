// Shapes of GET /api/access and GET /api/resources, and the plain words the Settings page uses for them.
// The API calls a group of domains a "product"; the page calls it a "group". The API names stay as they are.

export interface Product {
	id: string;
	name: string;
	archived_at?: number | null;
}
export interface Principal {
	id: string;
	name: string;
	kind: string;
	disabled_at: number | null;
}
export interface Credential {
	id: string;
	principal_id: string;
	name: string;
	prefix: string;
	expires_at: number;
	last_used_at?: number | null;
	revoked_at: number | null;
}
export interface Grant {
	id: string;
	principal_id: string;
	domain: string | null;
	actions: string;
	expires_at: number;
	revoked_at: number | null;
}
export interface Access {
	products: Product[];
	principals: Principal[];
	credentials: Credential[];
	grants: Grant[];
}
export interface Resource {
	id: number;
	domain: string;
	mappedProductIds: string[];
}
/** A key as POST /api/access/credentials returns it: the only time its secret is sent. */
export interface Issued {
	id: string;
	key: string;
	/** Set when this key replaces another one, which stays active until the owner confirms the new one is saved. */
	previousId?: string;
	/** What the key may do and on which domains, for the usage example. */
	actions: string[];
	domains: Resource[];
}

export type KeyAction = 'resources:read' | 'reports:read' | 'metrics:read' | 'diagnostics:run' | 'remediation:plan' | 'domains:manage';

/** Every action a key can be given, in plain words; the raw id is shown as secondary text. Same words as the agent consent page. */
export const KEY_ACTIONS: ReadonlyArray<{ id: KeyAction; label: string; detail: string }> = [
	{ id: 'resources:read', label: 'See its domains', detail: 'List the domains it was given and the groups they are in.' },
	{ id: 'reports:read', label: 'Read email health reports', detail: 'DNS findings, report history and what evidence is still missing.' },
	{ id: 'metrics:read', label: 'Read email statistics', detail: 'Pass rates and volumes from the reports received here.' },
	{ id: 'diagnostics:run', label: 'Run live DNS checks', detail: 'Look up the public DNS records of its domains. Changes nothing.' },
	{ id: 'remediation:plan', label: 'Suggest fixes', detail: 'Write the DNS changes it recommends, for you to review. It cannot apply them.' },
	{ id: 'domains:manage', label: 'Add domains', detail: 'Start monitoring a domain and check its ownership record. It does not edit DNS or send email.' },
];

export const DEFAULT_ACTIONS: KeyAction[] = ['resources:read', 'reports:read'];

/** The header a script sends its key in. `Authorization: Bearer` works too. */
export const KEY_HEADER = 'X-Api-Key';

export const accessKey = ['operator-access'];

/** A grant's actions as stored (a JSON array, or a comma-separated list in older rows). */
export function grantActions(actions: string): string[] {
	const raw = actions.trim();
	if (raw.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			/* fall through to the comma list */
		}
	}
	return raw
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
}

/** The plain label for an action id, or the id itself when it is not one a key can be given here. */
export const actionLabel = (id: string) => KEY_ACTIONS.find((a) => a.id === id)?.label ?? id;

export const timestamp = (value?: number | null) => (value ? new Date(value * 1000).toLocaleString(undefined, { timeZone: 'America/Santiago' }) : 'Never');
