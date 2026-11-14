import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { keys } from './queries';
import { useSession } from './session';

/** Cloudflare connections of the workspace (src/connections/routes.ts, docs/cloudflare-oauth.md). Never holds a token after a request. */
export interface CfConnection {
	id: string;
	label: string;
	auth_type: 'oauth' | 'token';
	status: 'active' | 'broken' | 'revoked';
	status_detail: string | null;
	cf_account_id: string | null;
	cf_account_name: string | null;
	scopes: string[];
	zones: { id: string; name: string }[];
	/** The server's own CLOUDFLARE_API_TOKEN: connected, no allow-list, cannot be edited here. */
	implicit?: true;
}

export interface CfConnections {
	connections: CfConnection[];
	oauth: { available: boolean; scopes: string[]; via_relay: boolean };
	token_paste: boolean;
	encryption_configured: boolean;
}

export interface CfZone {
	id: string;
	name: string;
	allowed: boolean;
}

export interface DnsState {
	name: string;
	resolves: boolean;
	spf: 'found' | 'missing' | 'error';
	dmarc: { state: 'found' | 'missing' | 'inherited' | 'error'; policy?: string };
	mx: boolean | null;
}

export const cfKeys = {
	connections: ['cf-connections'] as const,
	zones: (id: string) => ['cf-zones', id] as const,
	dnsState: (names: string[]) => ['dns-state', ...names] as const,
};

export const IMPLICIT_ID = 'env';

export const fetchConnections = () => api<CfConnections>('/api/cloudflare/connections');
export const startOAuth = (returnTo: string, connectionId?: string) =>
	api<{ authorize_url: string }>('/api/cloudflare/oauth/start', { method: 'POST', body: { return_to: returnTo, ...(connectionId ? { connection_id: connectionId } : {}) } });
export const addToken = (token: string) => api<{ connection: CfConnection }>('/api/cloudflare/connections', { method: 'POST', body: { token } });
export const fetchZones = (connection: CfConnection) =>
	connection.implicit
		? api<{ zones: Array<{ id: string; name: string }> }>('/api/zones').then((r) => r.zones.map((z): CfZone => ({ id: z.id, name: z.name, allowed: true })))
		: api<{ zones: CfZone[] }>(`/api/cloudflare/connections/${encodeURIComponent(connection.id)}/zones`).then((r) => r.zones);
export const setZones = (connectionId: string, zoneIds: string[]) =>
	api<{ zones: { id: string; name: string }[] }>(`/api/cloudflare/connections/${encodeURIComponent(connectionId)}/zones`, { method: 'PUT', body: { zone_ids: zoneIds } });
/** The server reads at most 10 names per request (each costs several DNS subrequests): ask in batches of 10, and again for whatever it says remains. */
export const DNS_STATE_BATCH = 10;
export async function fetchDnsState(names: string[]): Promise<DnsState[]> {
	const out: DnsState[] = [];
	let todo = [...names];
	for (let guard = 0; todo.length > 0 && guard < 20; guard++) {
		const batch = todo.slice(0, DNS_STATE_BATCH);
		const r = await api<{ states: DnsState[]; capped?: boolean; remaining?: string[] }>(`/api/onboarding/dns-state?names=${encodeURIComponent(batch.join(','))}`);
		out.push(...r.states);
		// Whatever the server cut from this batch, plus the names not asked yet.
		todo = [...(r.capped ? r.remaining ?? [] : []), ...todo.slice(DNS_STATE_BATCH)];
	}
	return out;
}
export const linkDomain = (domainId: number, connectionId: string | null) =>
	api<{ ok: true }>(`/api/domains/${domainId}/connection`, { method: 'PUT', body: { connection_id: connectionId } });

/** GET connections. `retry: false` and no refetch on mount: a refusal (403 member, hosted without Cloudflare) is an answer, not a blip (a refetch would flip FirstScreen back to its skeleton and remount in a loop). */
export function useCfConnections(enabled = true) {
	return useQuery({ queryKey: cfKeys.connections, queryFn: fetchConnections, retry: false, retryOnMount: false, staleTime: 15_000, enabled });
}

/** A connection that can be used right away: the server token, or an active stored one with at least one allowed zone. */
export function usableConnection(c: CfConnections | undefined): CfConnection | null {
	return c?.connections.find((x) => x.status === 'active' && (x.implicit || x.zones.length > 0)) ?? null;
}

/** Any active connection, even one that has no zones chosen yet. */
export function activeConnection(c: CfConnections | undefined): CfConnection | null {
	return c?.connections.find((x) => x.status === 'active') ?? null;
}

export function useCfZones(connection: CfConnection | null) {
	return useQuery({ queryKey: cfKeys.zones(connection?.id ?? ''), queryFn: () => fetchZones(connection!), enabled: !!connection, retry: false });
}

/**
 * What the domain forms may ask Cloudflare. Owners and admins only; no usable connection means no zone request at all
 * (GET /api/zones answers 400 without a token and would log a console error on every first-run screen).
 */
export function useCfOffer() {
	const { canWrite } = useSession();
	const conns = useCfConnections(canWrite);
	const connection = usableConnection(conns.data);
	const zones = useCfZones(connection);
	const zoneList = (zones.data ?? []).filter((z) => z.allowed);
	return {
		connection,
		/** Allowed zones of the usable connection; empty while loading or without one. */
		zoneList,
		/** The connections offer or the zone list is still loading. */
		pending: canWrite && (conns.isPending || (!!connection && zones.isPending)),
		/** Cloudflare can be connected, or already is. False until known, for members, and where the instance cannot offer it. */
		canConnect: cloudflareAvailable(conns.data),
	};
}

/** Whether the instance supports Cloudflare at all: OAuth, token paste, or a connection that already exists. */
export function cloudflareAvailable(c: CfConnections | undefined): boolean {
	return !!c && (c.oauth.available || c.token_paste || activeConnection(c) !== null);
}

export function useDnsState(names: string[]) {
	return useQuery({ queryKey: cfKeys.dnsState(names), queryFn: () => fetchDnsState(names), enabled: names.length > 0, retry: false, staleTime: 30_000 });
}

export function useStartOAuth() {
	return useMutation({ mutationFn: (v: { returnTo: string; connectionId?: string }) => startOAuth(v.returnTo, v.connectionId) });
}

export function useAddToken() {
	const qc = useQueryClient();
	return useMutation({ mutationFn: addToken, onSuccess: () => qc.invalidateQueries({ queryKey: cfKeys.connections }) });
}

export function useSetZones() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { connectionId: string; zoneIds: string[] }) => setZones(v.connectionId, v.zoneIds),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: cfKeys.connections });
			void qc.invalidateQueries({ queryKey: ['dns-state'] });
			void qc.invalidateQueries({ queryKey: ['cf-zones'] });
		},
	});
}

export function useLinkDomain() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { domainId: number; connectionId: string | null }) => linkDomain(v.domainId, v.connectionId),
		onSuccess: () => qc.invalidateQueries({ queryKey: keys.domains }),
	});
}

export const ENCRYPTION_MESSAGE =
	"This instance has no key to store a Cloudflare connection. Whoever runs it fixes that with one command, then reloads this page:";
export const ENCRYPTION_COMMAND = "openssl rand -base64 32 | sed 's/^/k1:/' | npx wrangler secret put TOKEN_ENCRYPTION_KEY";

export const isEncryptionMissing = (e: unknown): boolean => e instanceof ApiError && e.status === 503 && (e.body as { code?: string } | undefined)?.code === 'encryption_not_configured';

/** The OAuth return: `?cf_connection=` / `?cf_error=`, read once and removed from the address bar (the hash route stays). */
export function consumeOAuthReturn(): { connection?: string; error?: string } | null {
	const params = new URLSearchParams(window.location.search);
	const connection = params.get('cf_connection') ?? undefined;
	const error = params.get('cf_error') ?? undefined;
	if (!connection && !error) return null;
	params.delete('cf_connection');
	params.delete('cf_error');
	const q = params.toString();
	window.history.replaceState(window.history.state, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
	return { connection, error };
}

/** Plain words for the codes Cloudflare's consent screen or our callback can send back. */
export function oauthErrorMessage(code: string): string {
	if (code === 'access_denied') return 'Cloudflare access was not granted. Try again when you are ready to approve it.';
	return `Cloudflare could not be connected (${code}). Try again.`;
}

/** What the wizard remembers across a reload, per workspace. */
export interface CfWizardProgress {
	step: CfStepKey;
	domainIds: number[];
	written: { domains: number; records: number };
	connectionId?: string;
}
export type CfStepKey = 'connect' | 'zones' | 'domains' | 'dmarc' | 'reports_mailbox' | 'done';
export const CF_STEP_KEYS: CfStepKey[] = ['connect', 'zones', 'domains', 'dmarc', 'reports_mailbox', 'done'];
export const progressKey = (workspaceId: string | null) => `rsm_cf_wizard:${workspaceId ?? ''}`;

export function readProgress(workspaceId: string | null): CfWizardProgress | null {
	try {
		const raw = sessionStorage.getItem(progressKey(workspaceId));
		if (!raw) return null;
		const p = JSON.parse(raw) as Partial<CfWizardProgress>;
		if (!p.step || !CF_STEP_KEYS.includes(p.step) || !Array.isArray(p.domainIds)) return null;
		return { step: p.step, domainIds: p.domainIds.filter((n) => Number.isInteger(n)), written: { domains: p.written?.domains ?? 0, records: p.written?.records ?? 0 }, connectionId: p.connectionId };
	} catch {
		return null;
	}
}

export function writeProgress(workspaceId: string | null, p: CfWizardProgress): void {
	try {
		sessionStorage.setItem(progressKey(workspaceId), JSON.stringify(p));
	} catch {
		/* storage unavailable: no resume */
	}
}

export function clearProgress(workspaceId: string | null): void {
	try {
		sessionStorage.removeItem(progressKey(workspaceId));
	} catch {
		/* ignore */
	}
}
