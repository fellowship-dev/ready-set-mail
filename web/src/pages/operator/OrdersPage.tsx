import { Alert, Badge, EmptyState, PageHeader, Button } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { ListSkeleton, LoadError } from '../../components/states';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatMoney, orderDate, STATUS_WORDS, statusDate, type Order } from '../../lib/billing';
import { useHosted, useSession } from '../../lib/session';

interface OperatorOrder extends Order {
	workspace_id: string;
	workspace_name: string;
	stripe_invoice_id: string | null;
	next: 'started' | 'done' | null;
}

const key = ['operator-orders'] as const;

const tone = (o: Order) => (o.status === 'failed' ? 'danger' : o.status === 'paid' || o.status === 'done' ? 'success' : o.status === 'started' ? 'brand' : 'neutral');

function Line({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[6rem_1fr] gap-2">
			<dt className="text-ink-2">{label}</dt>
			<dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
		</div>
	);
}

/**
 * What /orders says when the server will not list orders. The server answers 404 while billing is off and 403 to anyone but the instance owner.
 * Only the instance owner is told what turns billing on (it is theirs to set); everyone else is only told the page is not theirs.
 */
export function ordersUnavailable(status: number, who: { instanceOwner: boolean; hosted: boolean }): { title: string; body: string } {
	if (who.instanceOwner && status === 404 && !who.hosted) {
		return { title: 'A self-hosted install has no orders', body: 'Orders belong to the hosted service\'s billing: this install does not sell anything, so there is nothing to list.' };
	}
	if (who.instanceOwner && status === 404) {
		return { title: 'Billing is off, so there are no orders', body: 'Orders appear once Stripe is set up: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on this instance (docs/billing.md), then deploy.' };
	}
	return { title: 'This page is not available to your account', body: 'Orders are for the person who runs this service.' };
}

/** The instance owner's orders, across workspaces. Refunds are made in the Stripe dashboard and arrive by webhook: there is no refund button. */
export function OrdersPage() {
	const { me } = useSession();
	const hosted = useHosted();
	const q = useQuery({ queryKey: key, queryFn: () => api<{ orders: OperatorOrder[] }>('/api/operator/orders'), retry: false });
	const unavailable = q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404) ? ordersUnavailable(q.error.status, { instanceOwner: !!me?.instance_owner, hosted }) : null;
	return (
		<div className="min-w-0 space-y-6">
			<PageHeader title="Orders" description={unavailable ? undefined : 'Orders from every workspace, newest first, whatever their status. Refunds are made in the Stripe dashboard.'} />
			{unavailable ? (
				<Alert variant="info" title={unavailable.title}>
					{unavailable.body}
				</Alert>
			) : q.isPending ? (
				<ListSkeleton rows={4} label="Loading orders" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the orders" />
			) : (
				<OrdersTable orders={q.data.orders} />
			)}
		</div>
	);
}

function OrdersTable({ orders }: { orders: OperatorOrder[] }) {
	const qc = useQueryClient();
	const [ask, setAsk] = useState<{ order: OperatorOrder; to: 'started' | 'done' } | null>(null);
	const move = useMutation({
		mutationFn: (v: { id: string; to: 'started' | 'done' }) => api(`/api/operator/orders/${v.id}/${v.to}`, { method: 'POST', body: {} }),
		onSuccess: () => {
			setAsk(null);
			void qc.invalidateQueries({ queryKey: key });
		},
	});
	if (orders.length === 0) return <EmptyState title="No orders yet" description="A paid order appears here with who bought it, for which domain and what to do next." />;
	return (
		<>
			{/* Below sm: one card per order, everything visible without scrolling sideways. From sm up: the table. */}
			<ul className="space-y-3 sm:hidden" aria-label="Orders">
				{orders.map((o) => (
					<li key={o.id} className="space-y-3 rounded-lg border border-line bg-surface-1 p-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Badge variant={tone(o)}>{STATUS_WORDS[o.status]}</Badge>
							<span className="text-sm font-medium">{formatMoney(o.amount_paid ?? o.amount, o.currency)}</span>
						</div>
						<dl className="space-y-1.5 text-sm">
							<Line label="Domain">{o.domain}</Line>
							<Line label="Workspace">{o.workspace_name}</Line>
							<Line label="Buyer">{o.buyer_email ?? '—'}</Line>
							<Line label="Ordered">{orderDate(o.created_at)}</Line>
							{o.status === 'pending' || o.status === 'paid' ? null : <Line label="Updated">{orderDate(statusDate(o))}</Line>}
						</dl>
						{o.next ? (
							<Button size="sm" variant="secondary" onClick={() => setAsk({ order: o, to: o.next! })}>
								{o.next === 'started' ? 'Mark started' : 'Mark done'}
							</Button>
						) : null}
					</li>
				))}
			</ul>
			<div className="relative hidden max-w-full overflow-x-auto rounded-lg border border-line bg-surface-1 sm:block">
				<table className="w-full min-w-[48rem] text-left text-sm">
					<thead className="border-b border-line text-xs uppercase text-ink-2">
						<tr>
							<th className="px-4 py-2 font-medium">Status</th>
							<th className="px-4 py-2 font-medium">Workspace</th>
							<th className="px-4 py-2 font-medium">Domain</th>
							<th className="px-4 py-2 font-medium">Buyer</th>
							<th className="px-4 py-2 font-medium">Amount</th>
							<th className="px-4 py-2 font-medium">Ordered</th>
							<th className="px-4 py-2 font-medium">Updated</th>
							<th className="px-4 py-2 font-medium">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{orders.map((o) => (
							<tr key={o.id} className="border-b border-line align-top last:border-0">
								<td className="px-4 py-2">
									<Badge variant={tone(o)}>{STATUS_WORDS[o.status]}</Badge>
								</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.workspace_name}</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.domain}</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.buyer_email ?? '—'}</td>
								<td className="px-4 py-2 whitespace-nowrap">{formatMoney(o.amount_paid ?? o.amount, o.currency)}</td>
								<td className="px-4 py-2 whitespace-nowrap">{orderDate(o.created_at)}</td>
								<td className="px-4 py-2 whitespace-nowrap">{o.status === 'pending' || o.status === 'paid' ? '—' : orderDate(statusDate(o))}</td>
								<td className="px-4 py-2 whitespace-nowrap">
									{o.next ? (
										<Button size="sm" variant="secondary" onClick={() => setAsk({ order: o, to: o.next! })}>
											{o.next === 'started' ? 'Mark started' : 'Mark done'}
										</Button>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<ConfirmDialog
				open={!!ask}
				onOpenChange={(o) => !o && setAsk(null)}
				title={ask?.to === 'done' ? 'Mark this order done?' : 'Mark this order started?'}
				description={ask?.to === 'done' ? `Do this once the written note that ${ask.order.domain} is done has gone out: after it the buyer can no longer ask for the full fee back.` : ask ? `You have written to the buyer about the access the work on ${ask.order.domain} needs.` : undefined}
				confirmLabel={ask?.to === 'done' ? 'Mark done' : 'Mark started'}
				busy={move.isPending}
				error={move.isError ? errorMessage(move.error) : null}
				onConfirm={() => ask && move.mutate({ id: ask.order.id, to: ask.to })}
			/>
		</>
	);
}
