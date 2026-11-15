import { Alert, Button, Input } from '@ready-set-mail/ui';
import { Copy } from 'lucide-react';
import { useHeadingTag } from '../../components/states';
import { KEY_HEADER, type Issued } from './access-model';
import { copyToClipboard, CopyValue } from './CopyValue';

/** The usage example for a new key: a request it is allowed to make, with the key read from an environment variable. */
function example(issued: Issued, origin: string): { label: string; command: string } | null {
	const send = `curl -H "${KEY_HEADER}: $READY_SET_MAIL_KEY"`;
	if (issued.actions.includes('resources:read')) return { label: 'Try it: list the domains this key can see', command: `${send} ${origin}/api/resources` };
	const first = issued.domains[0];
	if (first && issued.actions.includes('reports:read')) return { label: `Try it: read the health report of ${first.domain}`, command: `${send} ${origin}/api/domains/${first.id}/health-report` };
	return null;
}

/** A key just created or replaced: shown once, masked, with a copy button and how to use it. */
export function IssuedKeyPanel({ issued, busy, onAcknowledge }: { issued: Issued; busy: boolean; onAcknowledge: () => void }) {
	const H = useHeadingTag(2);
	const origin = window.location.origin;
	const tryIt = example(issued, origin);
	return (
		<div role="status" className="min-w-0 space-y-5 rounded-lg border border-line-strong bg-surface-2 p-4 sm:p-5">
			<div className="space-y-2">
				<p className="font-semibold text-ink-1">Copy this key now. It is shown only once.</p>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Input aria-label="New key" type="password" readOnly autoComplete="off" value={issued.key} className="min-w-0 flex-1 basis-56 font-mono" />
					<Button type="button" variant="secondary" onClick={() => void copyToClipboard(issued.key)}>
						<Copy aria-hidden />
						Copy key
					</Button>
				</div>
				{issued.previousId ? <p className="text-sm text-ink-2">The old key keeps working until you confirm the new one is saved.</p> : null}
			</div>
			<div className="space-y-3">
				<H className="text-sm font-semibold text-ink-1">How to use it</H>
				<p className="text-sm text-ink-2">
					Send the key in the <code className="font-mono">{KEY_HEADER}</code> header, or as <code className="font-mono">Authorization: Bearer</code>. Keep it in the program&apos;s secret settings,
					here as <code className="font-mono">READY_SET_MAIL_KEY</code>, never in code.
				</p>
				{tryIt ? <CopyValue label={tryIt.label} value={tryIt.command} copyLabel="Copy example command" /> : null}
				<CopyValue label="MCP address, for an agent that runs on its own" value={`${origin}/mcp`} copyLabel="Copy MCP address" hint="Give the agent the key as an Authorization: Bearer header." />
			</div>
			<Button type="button" disabled={busy} onClick={onAcknowledge}>
				{issued.previousId ? 'I saved the new key, revoke the old one' : 'I saved the key, hide it'}
			</Button>
		</div>
	);
}

/** Creating a key stopped after its identity was made: say so, and offer to remove it before trying again. */
export function PartialKeyAlert({ name, id, busy, onRemove }: { name: string; id: string; busy: boolean; onRemove: () => void }) {
	return (
		<Alert variant="danger" title="The key was not finished">
			<p className="[overflow-wrap:anywhere]">
				Creating “{name}” stopped partway (identity {id}). Remove it, then create the key again.
			</p>
			<Button type="button" size="sm" variant="danger" className="mt-3" disabled={busy} onClick={onRemove}>
				Remove the unfinished key
			</Button>
		</Alert>
	);
}
