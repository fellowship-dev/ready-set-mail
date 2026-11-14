import { Alert, Button } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { clearProgress } from '../../../lib/cloudflare';
import { appRoute, firstCheck, type NotWritten, type PlanStepKey, type PlanWrite } from '../../../lib/dns-plan';
import { useSession } from '../../../lib/session';

export interface DoneStepProps {
	domainIds: number[];
	written: { domains: number; records: number };
	notWritten: NotWritten[];
	/** Writes the plan still holds (a write that failed, or one that was never applied), with the step each belongs to. */
	pending?: { step: PlanStepKey; write: PlanWrite }[];
	/** Back to the step that holds a pending write. */
	onBack?: (step: PlanStepKey) => void;
}

const STEP_LABEL: Record<PlanStepKey, string> = { dmarc: 'DMARC', reports_mailbox: 'Reports mailbox' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DoneStep({ domainIds, written, notWritten, pending = [], onBack }: DoneStepProps) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { me } = useSession();
	const ids = domainIds.join(',');
	const check = useRef<Promise<unknown>>(Promise.resolve());
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		// Best effort: the overview reads DNS itself when this fails.
		check.current = domainIds.length ? firstCheck(domainIds).catch(() => {}) : Promise.resolve();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ids]);

	async function finish() {
		setLeaving(true);
		await check.current;
		await Promise.all([qc.invalidateQueries({ queryKey: ['domains'] }), qc.invalidateQueries({ queryKey: ['domain-summaries'] }), qc.invalidateQueries({ queryKey: ['domain-data'] })]).catch(() => {});
		clearProgress(me?.workspace_id ?? null);
		navigate('/');
	}

	return (
		<div className="space-y-4">
			<p className="text-lg font-semibold text-ink-1">
				{plural(written.domains, 'domain', 'domains')} added, {plural(written.records, 'record', 'records')} written
				{pending.length > 0 ? `, ${pending.length} still to write` : ''}
			</p>
			{pending.length > 0 ? (
				<Alert variant="warning" title="Still to write">
					<p>These were not written to Cloudflare. Nothing here has changed in your DNS.</p>
					<ul className="mt-2 space-y-2">
						{pending.map(({ step, write: w }) => (
							<li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span className="break-all">
									{w.type === 'EMAIL_ROUTING' ? `Address rule ${w.name}: ${w.content}` : `${w.type} ${w.name}: ${w.content}${w.priority !== undefined ? ` (priority ${w.priority})` : ''}`}
								</span>
								{onBack ? (
									<Button variant="secondary" size="sm" onClick={() => onBack(step)}>
										{`Back to the ${STEP_LABEL[step]} step`}
									</Button>
								) : null}
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			{notWritten.length > 0 ? (
				<Alert variant="info" title="Not written for you">
					<ul className="space-y-1">
						{notWritten.map((n, i) => (
							<li key={i}>
								{n.domain ? `${n.domain}: ` : ''}
								{n.what}. {n.reason}
								{n.link ? (
									<>
										{' '}
										<Link className="underline" to={appRoute(n.link)}>Set it up by hand</Link>
									</>
								) : null}
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			<p className="text-sm text-ink-2">Public DNS can take a few minutes to show the changes.</p>
			<div>
				<Button loading={leaving} onClick={() => void finish()}>
					{leaving ? 'Checking your domains…' : 'Go to overview'}
				</Button>
			</div>
		</div>
	);
}
