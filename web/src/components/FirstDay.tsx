import { Button, cn } from '@ready-set-mail/ui';
import { Check, Circle, Clock, TriangleAlert } from 'lucide-react';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { QUIET_AFTER_DAYS, type Blocker, type FirstDay } from '../lib/first-day';
import { REVIEW_PATH } from '../lib/first-run';
import { formatNumber, timeAgo } from '../lib/format';

const seenKey = (workspaceId: string) => `rsm_first_report_seen:${workspaceId}`;
export function firstReportSeen(workspaceId: string | null): boolean {
	try {
		return !!workspaceId && localStorage.getItem(seenKey(workspaceId)) === '1';
	} catch {
		return false;
	}
}

type Mark = 'done' | 'next' | 'later';
const ICON: Record<Mark, { icon: typeof Check; word: string }> = { done: { icon: Check, word: 'Done' }, next: { icon: Clock, word: 'Waiting' }, later: { icon: Circle, word: 'Later' } };

/** One line of the timeline: an icon and a word (never colour alone), then the fact. */
function Row({ mark, title, detail }: { mark: Mark; title: string; detail?: string }) {
	const { icon: Icon, word } = ICON[mark];
	return (
		<li className="flex gap-3">
			<Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', mark === 'done' ? 'text-success' : 'text-ink-2')} />
			<p className="min-w-0 text-sm text-ink-1">
				<span className="sr-only">{word}: </span>
				{title}
				{detail ? <span className="text-ink-2"> · {detail}</span> : null}
			</p>
		</li>
	);
}

/** "Test a real email": the existing Email check page. Absent where it cannot work. */
function TestEmail({ available, text }: { available: boolean; text?: string }) {
	if (!available) return null;
	return (
		<div className="space-y-2 border-t border-line pt-4">
			<p className="max-w-prose text-sm text-ink-2">{text ?? "Don't want to wait? Send any email to a one-time address and see SPF, DKIM and DMARC on a real message in under a minute."}</p>
			<Button asChild variant="secondary" size="sm">
				<Link to="/check">Test a real email</Link>
			</Button>
		</div>
	);
}

/** One compact line under the card's first line: a real failure that blocks progress. Warning tone, not red (nothing here is an emergency on day one). */
function BlockerLine({ blocker }: { blocker: Blocker }) {
	return (
		<p className="flex items-start gap-2 text-sm text-ink-1" data-testid="first-day-blocker">
			<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
			<span className="min-w-0 [overflow-wrap:anywhere]">
				{blocker.kind === 'connection' ? (
					<>
						{blocker.count === 1 ? blocker.label : `${blocker.count} Cloudflare connections`} can no longer reach Cloudflare, so nothing can be written until it is reconnected.{' '}
						<Link to="/settings" className="font-medium text-brand-ink underline underline-offset-4">
							Reconnect in Settings
						</Link>
					</>
				) : (
					<>
						Proof lost for {blocker.domain}: reports are not accepted until it is proven again.{' '}
						<button type="button" className="font-medium text-brand-ink underline underline-offset-4" onClick={() => document.querySelector('[data-testid^="proof-lost-"]')?.scrollIntoView({ block: 'center' })}>
							Prove it again
						</button>
					</>
				)}
			</span>
		</p>
	);
}

const BlockerContext = createContext<Blocker | null>(null);

function Frame({ title, children }: { title: string; children: ReactNode }) {
	const id = useId();
	const blocker = useContext(BlockerContext);
	return (
		<section aria-labelledby={id} className="space-y-4 rounded-lg border border-line bg-surface-1 p-4 sm:p-5" data-testid="first-day">
			<h2 id={id} className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
				{title}
			</h2>
			{blocker ? <BlockerLine blocker={blocker} /> : null}
			{children}
		</section>
	);
}

/**
 * The first day, in one card (spec D1): what has happened, what happens next, and the one thing to do if there is one. It goes
 * away when the normal overview takes over (the first report was seen). Plain words, no red: nothing here has failed.
 */
export function FirstDayCard({ blocker = null, ...props }: FirstDayCardProps) {
	return (
		<BlockerContext.Provider value={blocker}>
			<FirstDayBody {...props} />
		</BlockerContext.Provider>
	);
}

type FirstDayCardProps = { state: FirstDay; email?: string | null; emailCheck: boolean; workspaceId: string | null; onSeen?: () => void; /** A real failure to say in one line under the first line. */ blocker?: Blocker | null };

function FirstDayBody({ state, email, emailCheck, workspaceId, onSeen }: { state: FirstDay; email?: string | null; emailCheck: boolean; workspaceId: string | null; onSeen?: () => void }) {
	const [hidden, setHidden] = useState(false);
	if (hidden) return null;

	switch (state.kind) {
		case 'empty':
			return (
				<Frame title="Add the domain you send email from">
					<p className="max-w-prose text-sm text-ink-2">We read its SPF, DKIM and DMARC from public DNS right away. Adding it changes nothing in its DNS.</p>
					<Button asChild>
						<Link to="/setup">Add a domain</Link>
					</Button>
				</Frame>
			);
		case 'proof':
			return (
				<Frame title={state.lost ? `Prove ${state.domain} is still yours` : `Waiting for the DNS record that proves ${state.domain}`}>
					<p className="max-w-prose text-sm text-ink-2">{state.lost ? 'Its proof lapsed, so reports are not accepted for it until it is proven again. Reports and history stay.' : 'Ownership is shown by one DNS record. Its live DNS result is visible before then.'}</p>
					<Button asChild>
						<Link to="/setup">{state.lost ? 'Prove it again' : 'Continue setup'}</Link>
					</Button>
				</Frame>
			);
		case 'records':
			if (state.applied) {
				return (
					<Frame title={`Written to Cloudflare: waiting for public DNS to show ${state.domain}'s new record`}>
						<p className="max-w-prose text-sm text-ink-2">We look again every 15 seconds while this page is open.</p>
						<Button asChild variant="secondary" size="sm">
							<Link to={`/domains/${state.domainId}`}>Open {state.domain}</Link>
						</Button>
						<TestEmail available={emailCheck} />
					</Frame>
				);
			}
			return (
				<Frame title={`Waiting for the report address in ${state.domain}'s DMARC record`}>
					<p className="max-w-prose text-sm text-ink-2">Reports can only arrive once its DMARC record names our reporting address. {state.viaCloudflare ? 'Cloudflare is connected, so we can prepare the change and you press Apply.' : 'The domain page has Connect reports, which shows the exact record to add once the domain is connected. When it is in public DNS this page notices by itself.'}</p>
					<Button asChild>
						<Link to={state.viaCloudflare ? REVIEW_PATH : `/domains/${state.domainId}`}>{state.viaCloudflare ? 'Review the change' : 'See what to add'}</Link>
					</Button>
				</Frame>
			);
		case 'reports_off':
			return (
				<Frame title={`${state.domain} is checked from public DNS`}>
					<p className="max-w-prose text-sm text-ink-2">
						DMARC reports can't reach this workspace yet, so there are no report numbers to wait for. {state.reason ? `${state.reason} ` : ''}Its DNS records are still read every day.
					</p>
					<TestEmail available={emailCheck} text="To see SPF, DKIM and DMARC on a real message now, send any email to a one-time address. It takes under a minute." />
				</Frame>
			);
		case 'live':
			return (
				<Frame title="Your first reports are on their way">
					<p className="max-w-prose text-sm text-ink-2">Mail providers send DMARC reports about once a day. {email ? `We'll email ${email} when the first one arrives.` : "We'll email you when the first one arrives."}</p>
					<Button asChild variant="secondary" size="sm">
						<Link to={`/domains/${state.domainId}`}>Open {state.domain}</Link>
					</Button>
					<ul className="space-y-2" aria-label="Where things stand">
						<Row mark="done" title="Report address in DMARC" detail={state.readAt ? `seen in public DNS ${timeAgo(state.readAt)}` : 'seen in public DNS'} />
						<Row mark="next" title="First report" detail="usually within 24 to 48 hours" />
						<Row mark="later" title={`See every service that sends as ${state.domain}, then fix SPF and DKIM`} />
					</ul>
					<TestEmail available={emailCheck} />
				</Frame>
			);
		case 'quiet':
			return (
				<Frame title={`No reports yet for ${state.domain}`}>
					<p className="max-w-prose text-sm text-ink-2">
						Reports only come when mail has been sent from the domain. If it has, check that _dmarc still names our address.
						{state.readAt ? ` When we last read it, ${timeAgo(state.readAt)}, it did.` : ''} It has been more than {QUIET_AFTER_DAYS} days.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button asChild variant="secondary" size="sm">
							<Link to={`/domains/${state.domainId}`}>Open {state.domain}</Link>
						</Button>
					</div>
					<TestEmail available={emailCheck} />
				</Frame>
			);
		case 'arrived':
			return (
				<Frame title={`First reports for ${state.domain}`}>
					<p className="max-w-prose text-sm text-ink-2">
						{formatNumber(state.total)} {state.total === 1 ? 'message' : 'messages'} reported, {Math.round((state.passed / state.total) * 100)}% passed DMARC. See every service that sends as {state.domain} below.
					</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							try {
								if (workspaceId) localStorage.setItem(seenKey(workspaceId), '1');
							} catch {
								/* the card just shows again */
							}
							setHidden(true);
							onSeen?.();
						}}
					>
						Got it
					</Button>
				</Frame>
			);
	}
}
