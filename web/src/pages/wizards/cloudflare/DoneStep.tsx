import { Alert, Button } from '@ready-set-mail/ui';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { firstCheck, type NotWritten } from '../../../lib/dns-plan';

export interface DoneStepProps {
	domainIds: number[];
	written: { domains: number; records: number };
	notWritten: NotWritten[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DoneStep({ domainIds, written, notWritten }: DoneStepProps) {
	const navigate = useNavigate();
	const ids = domainIds.join(',');
	useEffect(() => {
		// Best effort: the overview reads DNS itself when this fails.
		if (domainIds.length) void firstCheck(domainIds).catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ids]);

	return (
		<div className="space-y-4">
			<p className="text-lg font-semibold text-ink-1">
				{plural(written.domains, 'domain', 'domains')} added, {plural(written.records, 'record', 'records')} written
			</p>
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
										<a href={n.link}>Set it up by hand</a>
									</>
								) : null}
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			<div>
				<Button onClick={() => navigate('/')}>Go to overview</Button>
			</div>
		</div>
	);
}
