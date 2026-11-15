import { Alert, Badge, Button, Card, CardContent, Checkbox, FieldError, FieldHint, Input, Label, Skeleton, toast } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { LoadError, Section } from '../../components/states';
import { ApiError, api, errorMessage } from '../../lib/api';
import {
	ENCRYPTION_MESSAGE,
	cfKeys,
	consumeOAuthReturn,
	isEncryptionMissing,
	oauthErrorMessage,
	useCfConnections,
	useCfZones,
	useSetZones,
	useStartOAuth,
	type CfAccount,
	type CfConnection,
} from '../../lib/cloudflare';
import { useSession } from '../../lib/session';

const STATUS: Record<CfConnection['status'], { label: string; variant: 'success' | 'warning' | 'danger' }> = {
	active: { label: 'Connected', variant: 'success' },
	broken: { label: 'Needs reconnecting', variant: 'warning' },
	revoked: { label: 'Revoked', variant: 'danger' },
};

type Panel = { id: string; kind: 'zones' | 'token' } | null;

/** Settings → Cloudflare: the connections of this workspace. Owners and admins only; the server refuses everyone else. */
export function CloudflareSection() {
	const { canWrite } = useSession();
	const conns = useCfConnections(canWrite);
	const [panel, setPanel] = useState<Panel>(null);
	const [removing, setRemoving] = useState<CfConnection | null>(null);
	const [returnError, setReturnError] = useState<string | null>(null);
	const returned = useRef(false);

	// Back from a reconnect at Cloudflare: read the result once, then clean the address bar.
	useEffect(() => {
		if (returned.current) return;
		returned.current = true;
		const r = consumeOAuthReturn();
		if (r?.error) setReturnError(oauthErrorMessage(r.error));
		if (r?.connection) void conns.refetch();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (!canWrite) return null;
	// Hosted without Cloudflare, or no permission: nothing to manage, nothing to say.
	if (conns.isError && conns.error instanceof ApiError && conns.error.status === 403) return null;

	const list = conns.data?.connections ?? [];
	return (
		<Section title="Cloudflare" description="Where Ready Set Mail may write DNS records for you, and in which zones.">
			{returnError ? <Alert variant="danger">{returnError}</Alert> : null}
			{conns.isPending ? (
				<Skeleton className="h-20 w-full" role="status" aria-label="Loading Cloudflare connections" />
			) : conns.isError ? (
				<LoadError error={conns.error} onRetry={() => void conns.refetch()} title="Could not load your Cloudflare connections" />
			) : (
				<>
					{list.length === 0 ? <p className="text-sm text-ink-2">No Cloudflare connection yet. Without one you copy each DNS record to your DNS provider yourself.</p> : null}
					{(conns.data.accounts ?? []).length > 0 ? <AccountList accounts={conns.data.accounts!} /> : null}
					{list.length > 0 ? <h3 className="text-sm font-semibold text-ink-1">Connections</h3> : null}
					<ul className="space-y-3">
						{list.map((c) => (
							<li key={c.id}>
								<ConnectionRow
									c={c}
									panel={panel?.id === c.id ? panel.kind : null}
									oauth={conns.data.oauth.available}
									onPanel={(kind) => setPanel(kind ? { id: c.id, kind } : null)}
									onRemove={() => setRemoving(c)}
								/>
							</li>
						))}
					</ul>
					<div>
						<Button asChild variant={list.length === 0 && !panel ? 'primary' : 'secondary'}>
							<Link to="/cloudflare/connect?back=%2Fsettings">Connect Cloudflare</Link>
						</Button>
					</div>
				</>
			)}
			{removing ? <DisconnectDialog c={removing} onClose={() => setRemoving(null)} /> : null}
		</Section>
	);
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/** Each Cloudflare account once, however many connections reach it: its name as Cloudflare gave it, its domains and whether it works. */
function AccountList({ accounts }: { accounts: CfAccount[] }) {
	return (
		<ul className="space-y-3" aria-label="Cloudflare accounts">
			{accounts.map((a) => {
				const date = when(a.connected_at);
				return (
					<li key={a.id}>
						<Card>
							<CardContent className="space-y-1 p-4">
								<p className="flex flex-wrap items-center gap-2 font-medium">
									<span className="[overflow-wrap:anywhere]">{a.name ?? 'Cloudflare account'}</span>
									<Badge variant={a.state === 'working' ? 'success' : 'warning'}>{a.state === 'working' ? 'Working' : 'Needs reconnecting'}</Badge>
								</p>
								<p className="text-sm text-ink-2">
									{a.domains} {a.domains === 1 ? 'domain' : 'domains'}
									{a.connections.length > 1 ? ` · ${a.connections.length} connections` : ''}
								</p>
								{a.connected_by || date ? (
									<p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
										Connected{a.connected_by ? ` by ${a.connected_by}` : ''}
										{date ? ` on ${date}` : ''}
									</p>
								) : null}
							</CardContent>
						</Card>
					</li>
				);
			})}
		</ul>
	);
}

function ConnectionRow({ c, panel, oauth, onPanel, onRemove }: { c: CfConnection; panel: 'zones' | 'token' | null; oauth: boolean; onPanel: (k: 'zones' | 'token' | null) => void; onRemove: () => void }) {
	const start = useStartOAuth();
	const st = STATUS[c.status];
	const broken = c.status !== 'active';
	const zoneText = c.implicit ? 'every zone the server token can see' : `${c.zones.length} ${c.zones.length === 1 ? 'zone' : 'zones'} allowed`;

	function reconnect() {
		if (c.auth_type === 'oauth') start.mutate({ returnTo: `/${window.location.hash}`, connectionId: c.id }, { onSuccess: (r) => window.location.assign(r.authorize_url) });
		else onPanel(panel === 'token' ? null : 'token');
	}

	return (
		<Card>
			<CardContent className="space-y-3 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="flex flex-wrap items-center gap-2 font-medium">
							<span className="[overflow-wrap:anywhere]">{c.label}</span>
							<Badge variant={st.variant}>{st.label}</Badge>
						</p>
						<p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
							{c.cf_account_name ? `Account ${c.cf_account_name}` : 'Account not known'} · {zoneText}
						</p>
						{broken && c.status_detail ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{c.status_detail}</p> : null}
					</div>
					{c.implicit ? (
						<p className="max-w-xs text-sm text-ink-2">This is the server&apos;s own token. Whoever runs the instance changes it.</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{broken ? (
								<Button variant="secondary" size="sm" loading={start.isPending} disabled={c.auth_type === 'oauth' && !oauth} onClick={reconnect}>
									Reconnect
								</Button>
							) : (
								<Button variant="secondary" size="sm" aria-expanded={panel === 'zones'} onClick={() => onPanel(panel === 'zones' ? null : 'zones')}>
									Choose zones
								</Button>
							)}
							<Button variant="danger" size="sm" onClick={onRemove}>
								Disconnect
							</Button>
						</div>
					)}
				</div>
				{start.isError ? <FieldError>{isEncryptionMissing(start.error) ? ENCRYPTION_MESSAGE : errorMessage(start.error)}</FieldError> : null}
				{panel === 'zones' ? <ZoneChooser c={c} onDone={() => onPanel(null)} /> : null}
				{panel === 'token' ? <TokenForm c={c} onDone={() => onPanel(null)} /> : null}
			</CardContent>
		</Card>
	);
}

function ZoneChooser({ c, onDone }: { c: CfConnection; onDone: () => void }) {
	const zones = useCfZones(c);
	const save = useSetZones();
	const [picked, setPicked] = useState<Set<string> | null>(null);
	if (zones.isPending) return <Skeleton className="h-16 w-full" role="status" aria-label="Loading your Cloudflare zones" />;
	if (zones.isError) return <LoadError error={zones.error} onRetry={() => void zones.refetch()} title="Could not list your Cloudflare zones" />;
	const selected = picked ?? new Set(zones.data.filter((z) => z.allowed).map((z) => z.id));
	const toggle = (id: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(id);
		else next.delete(id);
		setPicked(next);
	};
	return (
		<div className="space-y-3 border-t border-line pt-3">
			<p className="text-sm text-ink-2">Ready Set Mail only writes in the zones you tick.</p>
			{zones.data.length === 0 ? (
				<p className="text-sm text-ink-2">This Cloudflare account has no zones the connection can see.</p>
			) : (
				<ul className="divide-y divide-line rounded-lg border border-line" aria-label={`Zones of ${c.label}`}>
					{zones.data.map((z) => (
						<li key={z.id}>
							<label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
								<Checkbox checked={selected.has(z.id)} onCheckedChange={(v) => toggle(z.id, v === true)} />
								<span className="min-w-0 font-medium [overflow-wrap:anywhere]">{z.name}</span>
							</label>
						</li>
					))}
				</ul>
			)}
			{save.isError ? <FieldError>{errorMessage(save.error)}</FieldError> : null}
			<div className="flex flex-wrap gap-2">
				<Button loading={save.isPending} onClick={() => save.mutate({ connectionId: c.id, zoneIds: [...selected] }, { onSuccess: () => { toast({ variant: 'success', title: 'Zones saved' }); onDone(); } })}>
					Save zones
				</Button>
				<Button variant="secondary" onClick={onDone} disabled={save.isPending}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function TokenForm({ c, onDone }: { c: CfConnection; onDone: () => void }) {
	const qc = useQueryClient();
	const id = useId();
	const [token, setToken] = useState('');
	const save = useMutation({
		mutationFn: (t: string) => api(`/api/cloudflare/connections/${encodeURIComponent(c.id)}/token`, { method: 'PUT', body: { token: t } }),
		onSuccess: async () => {
			setToken('');
			await qc.invalidateQueries({ queryKey: cfKeys.connections });
			toast({ variant: 'success', title: 'Cloudflare reconnected' });
			onDone();
		},
	});
	function submit(e: FormEvent) {
		e.preventDefault();
		if (token.trim()) save.mutate(token.trim());
	}
	return (
		<form onSubmit={submit} className="max-w-md space-y-2 border-t border-line pt-3" noValidate>
			<Label htmlFor={id}>New Cloudflare API token</Label>
			<Input id={id} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
			<FieldHint>It is checked with Cloudflare before it replaces the old one.</FieldHint>
			{save.isError ? <FieldError>{isEncryptionMissing(save.error) ? ENCRYPTION_MESSAGE : errorMessage(save.error)}</FieldError> : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" loading={save.isPending} disabled={!token.trim()}>
					Save token
				</Button>
				<Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function DisconnectDialog({ c, onClose }: { c: CfConnection; onClose: () => void }) {
	// The account this connection is named for; any others came with the same sign-in.
	const all = c.accounts ?? [];
	const first = all.find((a) => a.id === c.cf_account_id || a.name === c.label) ?? all[0];
	const reached = all.length > 1 ? all.filter((a) => a !== first) : [];
	const qc = useQueryClient();
	const remove = useMutation({
		mutationFn: () => api(`/api/cloudflare/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: cfKeys.connections });
			void qc.invalidateQueries({ queryKey: ['dns-state'] });
			void qc.invalidateQueries({ queryKey: ['domains'] });
			toast({ variant: 'success', title: 'Cloudflare disconnected' });
			onClose();
		},
	});
	return (
		<ConfirmDialog
			open
			onOpenChange={(o) => (o ? undefined : onClose())}
			title={`Disconnect ${c.label}?`}
			description="Ready Set Mail stops writing DNS records through this connection. Records already written stay where they are."
			confirmLabel="Disconnect"
			busyLabel="Disconnecting…"
			variant="danger"
			busy={remove.isPending}
			error={remove.isError ? errorMessage(remove.error) : null}
			onConfirm={() => remove.mutate()}
		>
			{reached.length > 0 ? (
				<ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-ink-1">
					{reached.map((a) => (
						<li key={a.id}>
							This also disconnects {a.name ?? 'another Cloudflare account'}, which was connected in the same sign-in.
						</li>
					))}
				</ul>
			) : null}
			<p className="mb-3 text-sm text-ink-2">Your domains stay in Ready Set Mail, verified and watched. Changing their DNS needs a reconnect.</p>
			<p className="text-sm text-ink-2">
				{c.auth_type === 'token'
					? 'You pasted this token, so removing it here does not cancel it at Cloudflare. Revoke the token in your Cloudflare profile too.'
					: 'Access given through Cloudflare sign-in is revoked at Cloudflare as part of this. If you also pasted a token anywhere, revoke it at Cloudflare too.'}
			</p>
		</ConfirmDialog>
	);
}
