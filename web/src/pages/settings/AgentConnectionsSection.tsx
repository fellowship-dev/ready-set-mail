import { Badge, Card, CardContent, FieldError, Skeleton } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Section, useHeadingTag } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { cleanName } from '../../lib/names';
import { useHosted, useSession, useWorkspaceId } from '../../lib/session';
import { AccessKeysSection } from './AccessKeysSection';
import { timestamp } from './access-model';
import { ConfirmButton } from './ConfirmButton';
import { CopyValue } from './CopyValue';

export { accessKey, timestamp } from './access-model';

interface Connection {
	principalId: string;
	name: string;
	workspaceId: string;
	workspaceName?: string | null;
	createdAt: number;
	expiresAt: number;
	lastUsedAt?: number | null;
	revoked?: boolean;
}

/**
 * Settings → Agents: the agent address and the agents a person approved in the browser. On a self-hosted instance an
 * owner also gets access keys for scripts and services, collapsed below it (owners only; never on the hosted service).
 */
export function AgentConnectionsSection() {
	const { role } = useSession();
	const hosted = useHosted();
	const workspace = useWorkspaceId();
	const endpoint = `${window.location.origin}/mcp`;
	return (
		<>
			<Section title="Agents" description="Let an AI agent look at your domains, with your approval.">
				<Card>
					<CardContent className="space-y-5">
						<p className="text-sm text-ink-2">
							New to agents?{' '}
							<Link to="/agents" className="text-brand-ink underline underline-offset-4">
								Agents
							</Link>{' '}
							explains what they can do here and gives you a first question to ask.
						</p>
						<CopyValue
							label={hosted ? 'Agent address' : "This installation's MCP endpoint"}
							value={endpoint}
							copyLabel={hosted ? 'Copy agent address' : 'Copy MCP endpoint'}
						/>
						{hosted ? (
							<ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
								<li>In your AI agent, add Ready Set Mail and paste the agent address above.</li>
								<li>Restart the agent so it picks up Ready Set Mail.</li>
								<li>Sign in here when asked and approve which domains it may see, what it may do and for how long.</li>
								<li>Ask it for a health report on one of your domains. Adding it is not enough: it is connected once you approve.</li>
							</ol>
						) : (
							<ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
								<li>Install the Ready Set Mail plugin and set this HTTPS endpoint.</li>
								<li>Reload your client so its MCP tools become available.</li>
								<li>Sign in to this installation and approve exact resources, actions and expiry.</li>
								<li>Call whoami, then request a domain health report. Installation alone does not establish a connection.</li>
							</ol>
						)}
					</CardContent>
				</Card>
				<ApprovedAgents workspace={workspace} />
			</Section>
			{hosted ? null : role === 'owner' ? (
				<AccessKeysSection key={workspace} />
			) : (
				<p className="text-sm text-ink-2">Only a workspace owner can create access keys for scripts and services.</p>
			)}
		</>
	);
}

function ApprovedAgents({ workspace }: { workspace: string | null | undefined }) {
	const qc = useQueryClient();
	const H = useHeadingTag(1);
	const connections = useQuery({ queryKey: ['agent-connections', workspace], queryFn: () => api<{ connections: Connection[] }>('/api/mcp/connections'), retry: false });
	async function revoke(id: string) {
		await api(`/api/mcp/connections/${id}`, { method: 'DELETE' });
		await qc.invalidateQueries({ queryKey: ['agent-connections'] });
	}
	return (
		<Card>
			<CardContent className="space-y-3">
				<H className="font-semibold">Agents you approved</H>
				{connections.isPending ? (
					<Skeleton className="h-12 w-full" role="status" aria-label="Loading connections" />
				) : connections.isError ? (
					<FieldError>{errorMessage(connections.error)}</FieldError>
				) : !connections.data.connections.length ? (
					<p className="text-sm text-ink-2">No agents yet. An agent appears here once you approve it in the browser.</p>
				) : (
					<ul className="divide-y divide-line">
						{connections.data.connections.map((c) => (
							<li key={c.principalId} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
								<div className="min-w-0 space-y-1">
									<p className="font-medium [overflow-wrap:anywhere]">{c.name}</p>
									<dl className="grid gap-x-4 gap-y-0.5 text-sm text-ink-2 sm:grid-cols-[auto_1fr]">
										<dt>Workspace</dt>
										<dd className="min-w-0 [overflow-wrap:anywhere]">{c.workspaceName ? cleanName(c.workspaceName) : 'This workspace'}</dd>
										<dt>Created</dt>
										<dd>{timestamp(c.createdAt)}</dd>
										<dt>Expires</dt>
										<dd>{timestamp(c.expiresAt)}</dd>
										<dt>Last used</dt>
										<dd>{c.lastUsedAt === undefined ? 'Not recorded' : timestamp(c.lastUsedAt)}</dd>
									</dl>
								</div>
								{c.revoked ? (
									<Badge variant="neutral">Revoked</Badge>
								) : (
									<ConfirmButton
										label="Revoke"
										accessibleName={`Revoke ${c.name}`}
										title={`Revoke ${c.name}?`}
										description="Its next request is refused. To use it again, connect it and approve it again."
										confirmLabel="Revoke agent"
										onConfirm={() => revoke(c.principalId)}
									/>
								)}
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
