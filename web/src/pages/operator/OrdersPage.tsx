import { Alert, Badge, EmptyState, PageHeader, Button } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { ListSkeleton, LoadError } from '../../components/states';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatMoney, orderDate, STATUS_WORDS, statusDate, type Order } from '../../lib/billing';

interface OperatorOrder extends Order {
	workspace_id: string;
	workspace_name: string;
	stripe_invoice_id: string | null;
	next: 'started' | 'done' | null;
}

const key = ['operator-orders'] as const;

/** The instance owner's orders, across workspaces. Refunds are made in the Stripe dashboard and arrive by webhook: there is no refund button. */
export function OrdersPage() {
	const q = useQuery({ queryKey: key, queryFn: () => api<{ orders: OperatorOrder[] }>('/api/operator/orders'), retry: false });
	const forbidden = q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404);
	return (
		<div className="min-w-0 space-y-6">
			<PageHeader title="Orders" description="Paid orders from every workspace. Instance owner only. Refunds are made in the Stripe dashboard." />
			{forbidden ? (
				<Alert variant="info" title="Only the instance owner can see orders">
					Orders are the operator's, not a workspace's. They are visible to the account in OWNER_EMAIL, on the hosted service when billing is on.
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
			<div className="relative max-w-full overflow-x-auto rounded-lg border border-line bg-surface-1">
				<table className="w-full min-w-[56rem] text-left text-sm">
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
									<Badge variant={o.status === 'failed' ? 'danger' : o.status === 'paid' || o.status === 'done' ? 'success' : o.status === 'started' ? 'brand' : 'neutral'}>{STATUS_WORDS[o.status]}</Badge>
								</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.workspace_name}</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.domain}</td>
								<td className="px-4 py-2 [overflow-wrap:anywhere]">{o.buyer_email ?? '—'}</td>
								<td className="px-4 py-2 whitespace-nowrap">{formatMoney(o.amount, o.currency)}</td>
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
