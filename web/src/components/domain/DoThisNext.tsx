import { Button, Skeleton, StatusLabel } from '@ready-set-mail/ui';
import { RefreshCw } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DomainAction } from '../../lib/actions';

/**
 * The top of a domain page: one to three actions, each as Do this / Why, with who acts and where. `stale`: the stored
 * check could not be reloaded after this page's live read, so the steps come from the last one and may be out of date.
 * `afterFirst`: something offered once, right after the first step and before the others (the page's quiet offer), so it
 * is on the first screen without moving the first step down. With no list of steps it follows whatever is shown.
 */
export function DoThisNext({ actions, pending, canWrite, onRetry, stale = false, onReloadSummary, afterFirst }: { actions: DomainAction[]; pending: boolean; canWrite: boolean; onRetry: () => void; stale?: boolean; onReloadSummary?: () => void; afterFirst?: ReactNode }) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="text-lg font-semibold tracking-tight">
				Do this next
			</h2>
			{stale && !pending ? (
				<div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface-1 px-4 py-3 text-sm text-ink-2 sm:px-5">
					<span className="min-w-0 flex-1">These steps come from the last stored check and may be out of date: the latest could not be loaded.</span>
					{onReloadSummary ? (
						<Button variant="secondary" size="sm" onClick={onReloadSummary}>
							<RefreshCw aria-hidden />
							Try again
						</Button>
					) : null}
				</div>
			) : null}
			{pending ? (
				<div aria-busy="true" role="status" className="space-y-2 rounded-lg border border-line bg-surface-1 p-5">
					<Skeleton className="h-5 w-2/3" />
					<Skeleton className="h-4 w-1/2" />
					<span className="text-sm text-ink-2">Reading this domain's records from public DNS…</span>
				</div>
			) : actions[0]?.key === 'done' ? (
				// Nothing to do: a plain statement of what was verified and from what, with any notes below it. No numbered step.
				<div className="space-y-3 rounded-lg border border-line bg-surface-1 px-4 py-4 sm:px-5" data-status="verified">
					<p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink-1">
						<StatusLabel kind="verified" label="Nothing to do" />
						<span>{actions[0].why}</span>
					</p>
					{actions.length > 1 ? (
						<ul className="space-y-2 border-t border-line pt-3">
							{actions.slice(1).map((a) => (
								<li key={a.key} data-status={a.status} className="space-y-1 text-sm">
									<StatusLabel kind={a.status} />
									<p className="text-ink-1">{a.do}</p>
									<p className="max-w-prose text-ink-2">{a.why}</p>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : (
				<>
					<StepList actions={actions.slice(0, 1)} first={0} total={actions.length} canWrite={canWrite} onRetry={onRetry} />
					{afterFirst}
					{actions.length > 1 ? <StepList actions={actions.slice(1)} first={1} total={actions.length} canWrite={canWrite} onRetry={onRetry} /> : null}
				</>
			)}
			{pending || actions[0]?.key === 'done' ? afterFirst : null}
		</section>
	);
}

function StepList({ actions, first, total, canWrite, onRetry }: { actions: DomainAction[]; first: number; total: number; canWrite: boolean; onRetry: () => void }) {
	return (
		<ol start={first + 1} className="divide-y divide-line rounded-lg border border-line bg-surface-1">
			{actions.map((a, j) => (
				<li key={a.key} data-status={a.status} className="flex gap-3 px-4 py-4 sm:px-5">
					{total > 1 ? (
						<span aria-hidden className={first + j === 0 ? 'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-brand-ink bg-brand-subtle px-1.5 font-mono text-xs font-semibold text-brand-ink' : 'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-line-strong px-1.5 font-mono text-xs font-semibold text-ink-2'}>
							{first + j + 1}
						</span>
					) : null}
					<div className="min-w-0 flex-1 space-y-1.5">
						<StatusLabel kind={a.status} />
						<p className="text-base font-semibold text-ink-1">
							<span className="text-sm font-medium text-ink-2">Do this: </span>
							{a.do}
						</p>
						<p className="max-w-prose text-sm text-ink-2">
							<span className="font-medium text-ink-1">Why: </span>
							{a.why}
						</p>
						{a.record ? (
							<p className="max-w-prose text-sm text-ink-2">
								<span className="font-medium text-ink-1">Record offered{a.recordAt ? <> at <code className="font-mono text-xs">{a.recordAt}</code></> : null}: </span>
								<code className="break-all font-mono text-xs text-ink-1">{a.record}</code>
							</p>
						) : null}
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5 text-sm">
							<span className="text-ink-2">
								Who: <span className="text-ink-1">{a.who}</span>
							</span>
							{a.retry ? (
								<Button variant="secondary" size="sm" onClick={onRetry}>
									<RefreshCw aria-hidden />
									Check again
								</Button>
							) : a.to && (canWrite || !a.writes) ? (
								<Link to={a.to} className="rounded-sm font-medium text-brand-ink underline underline-offset-4">
									{a.cta ?? 'Open'}
								</Link>
							) : a.to ? (
								<span className="text-ink-2">An owner or admin makes this change.</span>
							) : null}
						</div>
					</div>
				</li>
			))}
		</ol>
	);
}
