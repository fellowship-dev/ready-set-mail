import { Button, Input, cn } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, Clock } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../lib/api';
import type { FirstDay } from '../lib/first-day';
import { formatDate, timeAgo } from '../lib/format';
import { handoffKeys, setupPathFor, type HandoffStatus } from '../lib/handoff';

type Mark = 'done' | 'next' | 'later';
const ICON = { done: { icon: Check, word: 'Done' }, next: { icon: Clock, word: 'Waiting' }, later: { icon: Circle, word: 'Later' } } as const;

function Row({ mark, title, detail }: { mark: Mark; title: string; detail?: string }) {
	const { icon: Icon, word } = ICON[mark];
	return (
		<li className="flex gap-3">
			<Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', mark === 'done' ? 'text-success' : 'text-ink-2')} />
			<p className="min-w-0 text-sm text-ink-1 [overflow-wrap:anywhere]">
				<span className="sr-only">{word}: </span>
				{title}
				{detail ? <span className="text-ink-2"> · {detail}</span> : null}
			</p>
		</li>
	);
}

/** Where the teammate's part stands, in words, from the invite and the domain's state. */
function connectLine(h: HandoffStatus, state: FirstDay | null): { mark: Mark; title: string; detail?: string } {
	if (!h.joined_at) return { mark: 'later', title: 'Connect Cloudflare or add the records', detail: 'not started' };
	if (state?.kind === 'proof') return { mark: 'next', title: 'Connect Cloudflare or add the records', detail: `waiting for the DNS record that proves ${h.domain}` };
	if (state?.kind === 'records') return { mark: 'next', title: 'Connect Cloudflare or add the records', detail: state.applied ? 'written to Cloudflare, waiting for public DNS' : 'in progress' };
	return { mark: 'next', title: 'Connect Cloudflare or add the records', detail: 'in progress' };
}

/**
 * H2, on the inviter's dashboard in place of the first-day card while a teammate finishes setup: who, and where it stands. It goes
 * away once the domain's records are live (the first-day card takes over). "Resend invitation" until they join; "Finish it myself"
 * opens that domain's first screen for the inviter (the teammate stays an admin).
 */
export function HandoffCard({ handoff: h, state, canResend }: { handoff: HandoffStatus; state: FirstDay | null; canResend: boolean }) {
	const id = useId();
	const qc = useQueryClient();
	const [note, setNote] = useState('');
	const [newLink, setNewLink] = useState('');
	const resend = useMutation({
		mutationFn: () => api<{ url?: string; emailed?: boolean }>(`/api/team/handoffs/${h.id}/resend`, { method: 'POST', body: {} }),
		onSuccess: (r) => {
			setNewLink(r.emailed === false && r.url ? r.url : '');
			setNote(r.emailed === false ? 'Here is a new link. The previous link no longer works.' : `Sent again to ${h.email}. The previous link no longer works.`);
			void qc.invalidateQueries({ queryKey: handoffKeys.list });
		},
		onError: (e) => setNote(errorMessage(e)),
	});
	const expired = !h.joined_at && h.expires_at * 1000 < Date.now();
	const date = formatDate(h.expires_at);
	const connect = connectLine(h, state);
	return (
		<section aria-labelledby={id} className="space-y-4 rounded-lg border border-line bg-surface-1 p-4 sm:p-5" data-testid="handoff-card">
			<h2 id={id} className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
				{h.email} is finishing setup
			</h2>
			<p className="max-w-prose text-sm text-ink-2">
				They were invited as an admin to finish <span className="font-mono">{h.domain}</span>. You keep full access as the owner.
			</p>
			<ul className="space-y-2" aria-label="Where things stand">
				<Row mark="done" title={h.emailed !== false ? `Invitation sent to ${h.email}` : `Link made for ${h.email}`} detail={timeAgo(h.sent_at)} />
				{h.joined_at ? <Row mark="done" title={`${h.email} joined`} detail={timeAgo(h.joined_at)} /> : <Row mark="next" title={expired ? `Not yet; the link expired on ${date}` : `Not yet; the link works until ${date}`} />}
				<Row {...connect} />
				<Row mark="later" title="First reports" />
			</ul>
			{note ? <p role="status" className="text-sm text-ink-2">{note}</p> : null}
			{newLink ? <Input readOnly aria-label="Invitation link" value={newLink} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" /> : null}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				{!h.joined_at && canResend ? (
					<Button variant="secondary" size="sm" loading={resend.isPending} onClick={() => resend.mutate()}>
						{h.emailed !== false ? 'Resend invitation' : 'Get a new link'}
					</Button>
				) : null}
				<Link to={setupPathFor(h.domain)} className="text-sm text-ink-2 underline underline-offset-4 hover:text-ink-1">
					Finish it myself
				</Link>
			</div>
		</section>
	);
}
