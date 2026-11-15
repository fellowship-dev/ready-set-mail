import { Alert, Badge, Button, Card, CardContent, CardFooter, Skeleton } from '@ready-set-mail/ui';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { Section } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { cardLine, formatMoney, openPortal, orderDate, startCardSession, STATUS_WORDS, statusDate, useBilling, type Order } from '../../lib/billing';
import { useCardReturn } from '../../lib/card-return';
import { useHosted } from '../../lib/session';

const TONE: Record<Order['status'], 'neutral' | 'success' | 'warning' | 'danger' | 'brand'> = {
	pending: 'neutral', paid: 'success', started: 'brand', done: 'success', refunded: 'neutral', failed: 'danger', canceled: 'neutral',
};

/** Settings -> Billing: the card on file, the billing email and past orders. Hosted, and only where billing is on. */
export function BillingSection() {
	const hosted = useHosted();
	const q = useBilling();
	useCardReturn();
	const portal = useMutation({ mutationFn: openPortal });
	const add = useMutation({ mutationFn: () => startCardSession('/settings') });
	if (!hosted || q.data === null) return null;
	if (q.isError) return null;
	const b = q.data;
	const failure = portal.error ?? add.error;

	return (
		<Section title="Billing" description="One card per workspace. Cards are added and changed on Stripe's own pages, never here.">
			{!b ? (
				<Skeleton className="h-32 w-full" />
			) : (
				<>
					<Card>
						<CardContent className="py-2">
							<dl className="divide-y divide-line">
								<Row label="Card">{b.card ? cardLine(b.card) : b.card_unavailable ? 'We could not read the card just now.' : 'No card on file.'}</Row>
								<Row label="Billing email">{b.billing_email ?? <span className="text-ink-2">The owner's email address, once a card is added.</span>}</Row>
							</dl>
						</CardContent>
						<CardFooter className="flex-wrap justify-between gap-3">
							{b.can_manage ? (
								<>
									<p className="text-sm text-ink-2">{b.has_customer ? 'The billing email is changed on Stripe too.' : ' '}</p>
									{b.card || b.has_customer ? (
										<Button variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}>
											<ExternalLink aria-hidden />
											Change card or see invoices
										</Button>
									) : (
										<Button variant="secondary" loading={add.isPending} onClick={() => add.mutate()}>
											<CreditCard aria-hidden />
											Add a card
										</Button>
									)}
								</>
							) : (
								<p className="text-sm text-ink-2">Only the workspace owner can add a card or buy.</p>
							)}
						</CardFooter>
					</Card>
					{failure ? (
						<Alert variant="danger" title="That did not work">
							{errorMessage(failure)}
						</Alert>
					) : null}

					<h3 className="pt-2 text-base font-semibold tracking-tight">Orders</h3>
					{b.orders.length === 0 ? (
						<p className="text-sm text-ink-2">No orders yet. When a domain has something to fix, its page offers to do it for you.</p>
					) : (
						<div className="relative overflow-x-auto rounded-lg border border-line bg-surface-1">
							<table className="w-full min-w-[34rem] text-left text-sm">
								<thead className="border-b border-line text-xs uppercase text-ink-2">
									<tr>
										<th className="px-4 py-2 font-medium">Domain</th>
										<th className="px-4 py-2 font-medium">Offer</th>
										<th className="px-4 py-2 font-medium">Amount</th>
										<th className="px-4 py-2 font-medium">Status</th>
										<th className="px-4 py-2 font-medium">Date</th>
									</tr>
								</thead>
								<tbody>
									{b.orders.map((o) => (
										<tr key={o.id} className="border-b border-line last:border-0">
											<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.domain_id ? <Link className="text-brand-ink underline underline-offset-4" to={`/domains/${o.domain_id}`}>{o.domain}</Link> : o.domain}</td>
											<td className="px-4 py-2">{b.offer?.id === o.offer ? b.offer.name : 'Fix one domain'}</td>
											<td className="px-4 py-2 whitespace-nowrap">{formatMoney(o.amount, o.currency)}</td>
											<td className="px-4 py-2">
												<Badge variant={TONE[o.status]}>{STATUS_WORDS[o.status]}</Badge>
											</td>
											<td className="px-4 py-2 whitespace-nowrap">{orderDate(statusDate(o))}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}
		</Section>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
			<dt className="text-sm text-ink-2">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-ink-1">{children}</dd>
		</div>
	);
}
