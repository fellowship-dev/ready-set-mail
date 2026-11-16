import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { formatNumber } from '../../lib/format';
import type { NameSeen } from '../../lib/types';
import { ListSkeleton, LoadError } from '../states';
import type { UseQueryResult } from '@tanstack/react-query';

/** What applies to a name, in a few words: the policy, the tag that sets it and whose record it is. */
export function policyWords(n: NameSeen): string {
	const e = n.effective;
	if (!e) return n.roles.includes('from') ? 'Not read' : 'Return-path only';
	if (e.status === 'error') return 'Could not be read';
	if (e.status === 'none') return 'No DMARC record';
	if (e.status === 'multiple') return `Several records at ${e.at}`;
	if (!e.policy) return `Record at ${e.at} not applied`;
	const where = e.source === 'own' ? 'its own record' : `${e.tag}= on ${e.at}`;
	return `${e.policy} (${e.status === 'broken' ? 'record not valid as written, ' : ''}${where})`;
}

/**
 * The names seen sending as this domain: its subdomains in the reports, inside the domain (not rows of their own), each with its mail, the policy that
 * applies to the name and where that comes from, and the one thing to fix. Hidden when the reports name no subdomain.
 */
export function SubdomainNames({ domainId, domain, q }: { domainId: number; domain: string; q: UseQueryResult<NameSeen[]> }) {
	if (q.isPending) return <ListSkeleton rows={1} label="Loading the names seen sending" />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the names seen sending" />;
	if (q.data.length === 0) return null;
	return (
		<div className="space-y-3">
			<p className="text-sm text-ink-2">
				Subdomains of {domain} that appear in its reports in the last 30 days, as the From domain or as the return-path. They are part of {domain}, not separate domains.{' '}
				<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/anomalies`}>
					Failing senders
				</Link>
			</p>
			<Table label="Names seen sending as this domain">
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead className="text-right">Messages</TableHead>
						<TableHead className="text-right">Failed DMARC</TableHead>
						<TableHead>Policy that applies</TableHead>
						<TableHead>Fix</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{q.data.map((n) => (
						<TableRow key={n.name}>
							<TableCell className="[overflow-wrap:anywhere]">
								<span className="block font-mono text-sm text-ink-1">{n.name}</span>
								<span className="block text-xs text-ink-2">{n.roles.map((r) => (r === 'from' ? 'sends as' : 'return-path')).join(', ')}</span>
							</TableCell>
							<TableCell className="text-right tabular-nums">{formatNumber(n.messages)}</TableCell>
							<TableCell className="text-right tabular-nums">{n.roles.includes('from') ? formatNumber(n.failed) : '–'}</TableCell>
							<TableCell>
								<span className="block">{policyWords(n)}</span>
								{n.source ? <span className="block text-xs text-ink-2">{n.source}</span> : null}
							</TableCell>
							<TableCell className="text-sm">{n.fix ?? 'Nothing to fix'}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
