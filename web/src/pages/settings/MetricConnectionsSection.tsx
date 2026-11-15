import { Badge, Button, Card, CardContent, Field, FieldError, Input, Skeleton } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Section, useHeadingTag } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useHosted, useSession, useWorkspaceId } from '../../lib/session';
import { timestamp } from './access-model';

interface GoogleConnection {
	domainId: number;
	domain: string;
	status: string;
	id?: string;
	lastAttemptAt?: number | null;
	lastSuccessAt?: number | null;
}

/** Settings → Google Postmaster metrics: connect, sync and disconnect Google per domain (owners only). */
export function MetricConnectionsSection() {
	const { role } = useSession();
	const hosted = useHosted();
	const workspace = useWorkspaceId();
	const qc = useQueryClient();
	const q = useQuery({
		queryKey: ['google-metric-connections', workspace],
		queryFn: () => api<{ configured: boolean; connections: GoogleConnection[] }>('/api/metrics/google/connections'),
		enabled: role === 'owner',
		retry: false,
	});
	const [days, setDays] = useState(30);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	async function act(fn: () => Promise<void>) {
		setError('');
		setBusy(true);
		try {
			await fn();
			await qc.invalidateQueries({ queryKey: ['google-metric-connections'] });
			await qc.invalidateQueries({ queryKey: ['health-report'] });
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	}
	if (hosted && q.data && !q.data.configured) return null;
	const validDays = Number.isInteger(days) && days >= 1 && days <= 90;

	return (
		<Section title="Google Postmaster metrics" description="Read Google-reported Gmail metrics for each domain. Google consent does not grant an agent access.">
			{role !== 'owner' ? (
				<p className="text-sm text-ink-2">Only a workspace owner can connect or disconnect Google Postmaster.</p>
			) : q.isPending ? (
				<Skeleton className="h-20 w-full" role="status" aria-label="Loading metric connections" />
			) : q.isError ? (
				<FieldError>{errorMessage(q.error)}</FieldError>
			) : (
				<Card>
					<CardContent className="min-w-0 space-y-5">
						{!q.data.configured && !hosted ? (
							<p role="status" className="text-sm">
								Google Postmaster is not configured on this installation. The installer must configure its Google OAuth application and token encryption before connections are available.
							</p>
						) : null}
						<p className="text-sm text-ink-2">
							Provider-suppressed or absent data is unavailable, never zero. Spam complaints, DMARC alignment, TLS and inbox placement measure different populations.
						</p>
						<div className="max-w-xs">
							<Field id="google-sync-days" label="Sync previous days (1–90)">
								<Input id="google-sync-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />
							</Field>
						</div>
						{!q.data.connections.length ? <p className="text-sm text-ink-2">Enroll a domain before connecting Google Postmaster.</p> : null}
						<ul className="divide-y divide-line border-t border-line">
							{q.data.connections.map((c) => (
								<li key={c.domainId} className="py-4 last:pb-0">
									<GoogleRow c={c} busy={busy} configured={q.data.configured} validDays={validDays} days={days} act={act} />
								</li>
							))}
						</ul>
						{error ? <FieldError>{error}</FieldError> : null}
					</CardContent>
				</Card>
			)}
		</Section>
	);
}

function GoogleRow({
	c,
	busy,
	configured,
	validDays,
	days,
	act,
}: {
	c: GoogleConnection;
	busy: boolean;
	configured: boolean;
	validDays: boolean;
	days: number;
	act: (fn: () => Promise<void>) => Promise<void>;
}) {
	const H = useHeadingTag(1);
	const connected = c.status !== 'not_connected';
	const connect = () =>
		act(async () => {
			const result = await api<{ authorize_url: string }>('/api/metrics/google/oauth/start', { method: 'POST', body: { domain_id: c.domainId } });
			window.location.assign(result.authorize_url);
		});
	const sync = () =>
		act(async () => {
			const until = Math.floor(Date.now() / 1000);
			await api(`/api/metrics/google/domains/${c.domainId}/sync`, { method: 'POST', body: { since: until - days * 86400, until } });
		});
	const disconnect = () =>
		act(async () => {
			await api(`/api/metrics/google/domains/${c.domainId}`, { method: 'DELETE' });
		});
	return (
		<div className="min-w-0 space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<H className="min-w-0 font-mono font-semibold [overflow-wrap:anywhere]">{c.domain}</H>
				<Badge variant={c.status === 'connected' ? 'success' : 'neutral'}>{c.status.replaceAll('_', ' ')}</Badge>
			</div>
			<dl className="grid gap-x-4 gap-y-0.5 text-sm text-ink-2 sm:grid-cols-[auto_1fr]">
				<dt>Last attempt</dt>
				<dd>{timestamp(c.lastAttemptAt)}</dd>
				<dt>Last successful fetch</dt>
				<dd>{timestamp(c.lastSuccessAt)}</dd>
			</dl>
			{c.lastSuccessAt ? (
				<p className="text-sm text-ink-2">
					Cache age: {Math.max(0, Math.floor((Date.now() / 1000 - c.lastSuccessAt) / 60))} minutes. Source periods are shown in the domain health report.
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="secondary" aria-label={`${connected ? 'Reconnect' : 'Connect'} Google for ${c.domain}`} disabled={busy || !configured} onClick={() => void connect()}>
					{connected ? 'Reconnect Google' : 'Connect Google'}
				</Button>
				<Button size="sm" variant="secondary" aria-label={`Sync ${c.domain}`} disabled={busy || !configured || !connected || !validDays} onClick={() => void sync()}>
					Sync
				</Button>
				{connected ? (
					<Button size="sm" variant="danger" aria-label={`Disconnect ${c.domain}`} disabled={busy} onClick={() => void disconnect()}>
						Disconnect
					</Button>
				) : null}
			</div>
		</div>
	);
}
