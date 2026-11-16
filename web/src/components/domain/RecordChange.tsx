import { Fragment, type ReactNode } from 'react';
import type { PlanWrite } from '../../lib/dns-plan';

/** What the card needs of a record write: a plan's write (Review, first run) and the record "Connect reports" would apply are both this. */
export type ChangeWrite = Pick<PlanWrite, 'id' | 'type' | 'name' | 'content' | 'before' | 'action' | 'reason'>;

/** A DMARC value with its report address picked out, so what is added is the thing the eye finds. */
function WithRua({ value, mark }: { value: string; mark: boolean }): ReactNode {
	const parts = value.split(/(rua=[^;\s]+)/i);
	return (
		<>
			{parts.map((p, i) =>
				/^rua=/i.test(p) && mark ? (
					<mark key={i} className="rounded-sm bg-surface-3 px-0.5 font-semibold text-ink-1">
						{p}
					</mark>
				) : (
					<Fragment key={i}>{p}</Fragment>
				),
			)}
		</>
	);
}

const hasRua = (v: string | null | undefined) => !!v && /(^|;)\s*rua\s*=/i.test(v);

/** One record to be written: what it is, what is there now, what it will be after Apply, and why. No Copy: nothing here is for pasting. */
export function Change({ w }: { w: ChangeWrite }) {
	const kind = w.action === 'update' ? 'Update' : w.action === 'create' ? 'New' : w.action === 'delete' ? 'Remove' : 'Already in place';
	const label = w.name.startsWith('_dmarc.') ? `DMARC · ${w.type} _dmarc` : `${w.type} ${w.name}`;
	// Only a rua that this change adds is highlighted.
	const added = !hasRua(w.before) && hasRua(w.content);
	return (
		<li className="space-y-2 rounded-lg border border-line bg-surface-1 p-4" data-testid={`change-${w.id}`}>
			<p className="text-sm font-semibold text-ink-1">
				{label} · {kind}
			</p>
			{w.action === 'update' && w.before ? (
				<p className="text-sm text-ink-2">
					<span className="font-medium text-ink-1">Now:</span> <code className="font-mono text-xs [overflow-wrap:anywhere]">{w.before}</code>
				</p>
			) : null}
			<p className="text-sm text-ink-2">
				<span className="font-medium text-ink-1">{w.action === 'update' ? 'After Apply:' : 'Will be:'}</span>{' '}
				<code className="font-mono text-xs [overflow-wrap:anywhere]">
					<WithRua value={w.content} mark={added} />
				</code>
			</p>
			<p className="max-w-prose text-sm text-ink-2">{w.reason}</p>
		</li>
	);
}
