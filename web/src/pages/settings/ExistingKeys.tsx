import { Badge, Button } from '@ready-set-mail/ui';
import type { ReactNode } from 'react';
import { useHeadingTag } from '../../components/states';
import { actionLabel, grantActions, timestamp, type Access, type Credential, type Principal, type Resource } from './access-model';
import { ConfirmButton } from './ConfirmButton';

type Revoke = (type: 'principals' | 'credentials' | 'grants', id: string) => Promise<void>;

/** The keys that exist (the API's service principals with their credentials and grants), to replace or revoke. */
export function ExistingKeys({
	access,
	domains,
	busy,
	canReplace,
	replacing,
	replacementPanel,
	onReplace,
	onRevoke,
}: {
	access: Access;
	domains: Resource[];
	busy: boolean;
	canReplace: boolean;
	/** The credential whose replacement is on screen, if any. */
	replacing: string | null;
	replacementPanel: ReactNode;
	onReplace: (c: Credential, actions: string[], domains: Resource[]) => void;
	onRevoke: Revoke;
}) {
	const H = useHeadingTag(1);
	const services = access.principals.filter((p) => p.kind === 'service');
	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<H className="font-semibold text-ink-1">Your keys</H>
				<p className="max-w-2xl text-sm text-ink-2">Replacing a key keeps its domains, actions and their end date. The new key expires after the days chosen in step 2.</p>
			</div>
			{services.length === 0 ? (
				<p className="text-sm text-ink-2">No keys yet. Keys you create appear here.</p>
			) : (
				<ul className="space-y-3">
					{services.map((p) => (
						<li key={p.id}>
							<KeyCard
								principal={p}
								access={access}
								domains={domains}
								busy={busy}
								canReplace={canReplace}
								replacing={replacing}
								replacementPanel={replacementPanel}
								onReplace={onReplace}
								onRevoke={onRevoke}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function KeyCard({
	principal: p,
	access,
	domains,
	busy,
	canReplace,
	replacing,
	replacementPanel,
	onReplace,
	onRevoke,
}: {
	principal: Principal;
	access: Access;
	domains: Resource[];
	busy: boolean;
	canReplace: boolean;
	replacing: string | null;
	replacementPanel: ReactNode;
	onReplace: (c: Credential, actions: string[], domains: Resource[]) => void;
	onRevoke: Revoke;
}) {
	const H = useHeadingTag(2);
	const disabled = p.disabled_at !== null;
	const grants = access.grants.filter((g) => g.principal_id === p.id);
	const credentials = access.credentials.filter((c) => c.principal_id === p.id);
	const live = grants.filter((g) => g.revoked_at === null);
	const grantedActions = [...new Set(live.flatMap((g) => grantActions(g.actions)))];
	const grantedDomains = domains.filter((d) => live.some((g) => g.domain === d.domain));
	return (
		<div className="min-w-0 space-y-4 rounded-lg border border-line p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<H className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-ink-1">
					<span className="[overflow-wrap:anywhere]">{p.name}</span>
					{disabled ? <Badge variant="neutral">Disabled</Badge> : null}
				</H>
				{disabled ? null : (
					<ConfirmButton
						label="Disable"
						accessibleName={`Disable ${p.name}`}
						title={`Disable ${p.name}?`}
						description="All of its keys stop working and its access ends. This cannot be undone: create a new key to give access again."
						confirmLabel="Disable"
						disabled={busy}
						onConfirm={() => onRevoke('principals', p.id)}
					/>
				)}
			</div>

			{credentials.length ? (
				<ul className="divide-y divide-line border-t border-line">
					{credentials.map((c) => (
						<li key={c.id} className="space-y-3 py-3 last:pb-0">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<dl className="grid min-w-0 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[auto_1fr]">
									<dt className="text-ink-2">Key</dt>
									<dd className="min-w-0 [overflow-wrap:anywhere]">
										<code className="font-mono">{c.prefix}…</code> {c.revoked_at !== null ? <Badge variant="neutral">Revoked</Badge> : null}
									</dd>
									<dt className="text-ink-2">Expires</dt>
									<dd>{timestamp(c.expires_at)}</dd>
									<dt className="text-ink-2">Last used</dt>
									<dd>{timestamp(c.last_used_at)}</dd>
								</dl>
								{c.revoked_at === null ? (
									<div className="flex flex-wrap gap-2">
										<Button size="sm" variant="secondary" aria-label={`Replace ${c.name}`} disabled={busy || !canReplace || disabled} onClick={() => onReplace(c, grantedActions, grantedDomains)}>
											Replace
										</Button>
										<ConfirmButton
											label="Revoke"
											accessibleName={`Revoke ${c.name}`}
											title={`Revoke ${c.name}?`}
											description="Programs using this key are refused from their next request. This cannot be undone."
											confirmLabel="Revoke key"
											disabled={busy}
											onConfirm={() => onRevoke('credentials', c.id)}
										/>
									</div>
								) : null}
							</div>
							{replacing === c.id ? replacementPanel : null}
						</li>
					))}
				</ul>
			) : null}

			{grants.length ? (
				<div className="space-y-2 border-t border-line pt-3">
					<p className="text-sm font-medium text-ink-1">Access</p>
					<ul className="space-y-2">
						{grants.map((g) => (
							<li key={g.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md bg-surface-2 px-3 py-2 text-sm">
								<div className="min-w-0 space-y-0.5">
									<p className="flex flex-wrap items-center gap-2">
										<code className="font-mono [overflow-wrap:anywhere]">{g.domain ?? 'Not limited to one domain'}</code>
										{g.revoked_at !== null ? <Badge variant="neutral">Removed</Badge> : null}
									</p>
									<p className="text-ink-2">{grantActions(g.actions).map(actionLabel).join(' · ')}</p>
									<p className="text-ink-2">Ends {timestamp(g.expires_at)}</p>
								</div>
								{g.revoked_at === null ? (
									<ConfirmButton
										label="Remove"
										accessibleName={`Remove ${g.domain ?? 'access'} from ${p.name}`}
										title={`Remove ${g.domain ?? 'this access'} from ${p.name}?`}
										description="The key can no longer see this domain. Its other domains are not affected."
										confirmLabel="Remove"
										disabled={busy}
										onConfirm={() => onRevoke('grants', g.id)}
									/>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
