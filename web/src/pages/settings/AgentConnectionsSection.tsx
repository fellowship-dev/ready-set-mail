import { Badge, Card, CardContent, FieldError, Skeleton } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Section, useHeadingTag } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { cleanName } from '../../lib/names';
import { useHosted, useSession, useWorkspaceId } from '../../lib/session';
import { AccessKeysSection } from './AccessKeysSection';
import { actionLabel, timestamp } from './access-model';
import { ConfirmButton } from './ConfirmButton';
import { CopyValue } from './CopyValue';

export { accessKey, timestamp } from './access-model';

interface Connection {
	principalId: string;
	/** What the app is led with: its publisher's host, or the address it sends you back to. Never a name the app chose. */
	name: string;
	/** The name the app gave itself, shown as its own words. */
	calledItself?: string;
	/** It used the name of a well-known app, which is not shown. */
	nameWithheld?: boolean;
	workspaceId: string;
	workspaceName?: string | null;
	createdAt: number;
	expiresAt: number;
	lastUsedAt?: number | null;
	revoked?: boolean;
	/** The app identified itself with a published client document; `verifiedHost` is its publisher. Otherwise it named itself. */
	verified?: boolean;
	verifiedHost?: string;
	/** What it can reach, by name (live grants). */
	access?: { workspaces: string[]; domains: string[]; products: string[]; actions: string[] };
}

const SHOWN_DOMAINS = 5;
const list = (items: string[], shown = SHOWN_DOMAINS) => (items.length > shown ? `${items.slice(0, shown).join(', ')} and ${items.length - shown} more` : items.join(', '));

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
						<CopyValue
							label={hosted ? 'Agent address' : "This installation's MCP endpoint"}
							value={endpoint}
							copyLabel={hosted ? 'Copy agent address' : 'Copy MCP endpoint'}
						/>
						<p className="text-sm text-ink-2">
							How to connect Claude, ChatGPT, Cursor or VS Code, and what an agent can and cannot do: see{' '}
							<Link to="/agents" className="text-brand-ink underline underline-offset-4">
								Agents
							</Link>
							.
						</p>
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
	const connections = useQuery({ queryKey: ['agent-connections', workspace], queryFn: () => api<{ connections: Connection[] }>('/api/mcp/connections'), retry: false, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true });
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
									<p className="flex flex-wrap items-center gap-2 font-medium [overflow-wrap:anywhere]">
										{c.name}
										{c.verified ? null : <Badge variant="neutral">Not verified</Badge>}
									</p>
									<dl className="grid gap-x-4 gap-y-0.5 text-sm text-ink-2 sm:grid-cols-[auto_1fr]">
										{c.calledItself ? (
											<>
												<dt>Calls itself</dt>
												<dd className="min-w-0 [overflow-wrap:anywhere]">&ldquo;{cleanName(c.calledItself)}&rdquo;{c.verified ? '' : ' (its own word for itself)'}</dd>
											</>
										) : null}
										{c.nameWithheld ? (
											<>
												<dt>Name</dt>
												<dd className="min-w-0">It used the name of a well-known app, so the name is not shown: only the address above is known.</dd>
											</>
										) : null}
										<dt>Workspace</dt>
										<dd className="min-w-0 [overflow-wrap:anywhere]">{c.workspaceName ? cleanName(c.workspaceName) : 'This workspace'}</dd>
										{c.verified && c.verifiedHost ? (
											<>
												<dt>Published by</dt>
												<dd className="min-w-0 [overflow-wrap:anywhere]">{c.verifiedHost}</dd>
											</>
										) : null}
										<dt>Approved</dt>
										<dd>{timestamp(c.createdAt)}</dd>
										{c.access?.domains.length ? (
											<>
												<dt>Can see</dt>
												<dd className="min-w-0 [overflow-wrap:anywhere]">
													{list(c.access.domains)}
													{c.access.products.length ? ` (groups: ${list(c.access.products)})` : ''}
												</dd>
											</>
										) : null}
										{c.access?.actions.length ? (
											<>
												<dt>Can do</dt>
												<dd className="min-w-0">{c.access.actions.map(actionLabel).join(', ')}</dd>
											</>
										) : null}
										<dt>{c.revoked ? 'Would have ended' : 'Ends'}</dt>
										<dd>{timestamp(c.expiresAt)}</dd>
										<dt>Last used</dt>
										<dd>{c.lastUsedAt ? timestamp(c.lastUsedAt) : 'Not used yet'}</dd>
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
