import { Alert, Button } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { billingKeys, formatMoney, isOpenOrder, orderSentence, useBilling, useDomainBilling, useOrder, type Order } from '../../lib/billing';
import { useCardReturn, useStripParams } from '../../lib/card-return';
import type { Domain } from '../../lib/types';
import { ConfirmFix } from './ConfirmFix';

/**
 * Right after the first step of "Do this next" (it is passed to that list as `afterFirst`): the quiet offer to have Ready Set Mail fix a domain, and the state of an order once there is one. Hosted only, and only
 * where billing is on (the server answers 404 otherwise and nothing is rendered). `eligible` is the page's own verdict: something to fix, never
 * a domain that is fine, still reading, unproven or not resolving. It is offered once, here, and never repeated elsewhere.
 */
export function FixOffer({ domain, eligible }: { domain: Domain; eligible: boolean }) {
	const billing = useBilling();
	const on = !!billing.data;
	const q = useDomainBilling(domain.id, on);
	const [params] = useSearchParams();
	const strip = useStripParams();
	const [open, setOpen] = useState(false);
	useCardReturn({ strip: false });

	const d = q.data;
	const openOrder = d?.open_order ?? null;
	const latest = d?.orders[0] ?? null;
	// Back from adding a card: reopen the same confirm step.
	const reopen = params.get('order') === 'fix-one-domain';
	useEffect(() => {
		if (!billing.isSuccess) return;
		if (!reopen) {
			if (params.get('card')) strip('card'); // nothing to reopen: just take the return parameter out
			return;
		}
		// The page decides whether the domain still has something to fix only once it has read DNS: wait for that (or for an order that settles it).
		if (!d || !(eligible || d.open_order)) return;
		if (eligible && !d.open_order && d.offer) setOpen(true);
		strip('order', 'card'); // both in one step: two router updates in one tick undo each other
	}, [billing.isSuccess, d, eligible, reopen]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!on || !d) return null;
	const offer = d.offer;
	const showOffer = eligible && !openOrder && !!offer;
	const note = !openOrder && latest && (latest.status === 'done' || latest.status === 'refunded' || latest.status === 'failed') ? latest : null;
	if (!openOrder && !note && !showOffer) return null;

	return (
		<>
			{openOrder ? <OrderState order={openOrder} next={offer?.next_steps ?? ''} domainId={domain.id} /> : null}
			{note ? <OrderNote order={note} next={offer?.next_steps ?? ''} /> : null}
			{showOffer && offer ? (
				<section aria-labelledby="fix-offer-title" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-line bg-surface-1 px-4 py-4 sm:px-5">
					<div className="min-w-0 flex-1 space-y-1 basis-64">
						<h2 id="fix-offer-title" className="text-sm font-semibold">
							{offer.name}
						</h2>
						<p className="text-sm text-ink-2">{offer.scope}</p>
					</div>
					<Button variant="secondary" onClick={() => setOpen(true)}>
						Have us fix this domain: {formatMoney(offer.amount, offer.currency)}
					</Button>
				</section>
			) : null}
			{offer ? <ConfirmFix open={open} onOpenChange={setOpen} domain={domain} billing={d} offer={offer} /> : null}
		</>
	);
}

/** An order that holds the domain: waiting, paid or started. A pending one is polled until Stripe has said. */
function OrderState({ order, next, domainId }: { order: Order; next: string; domainId: number }) {
	const qc = useQueryClient();
	const polled = useOrder(order.status === 'pending' ? order.id : null);
	const live = polled.data ?? order;
	useEffect(() => {
		if (polled.data && polled.data.status !== order.status) void qc.invalidateQueries({ queryKey: billingKeys.domain(domainId) });
	}, [polled.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<section aria-label="Your order" className="space-y-2 rounded-lg border border-line bg-surface-1 px-4 py-4 sm:px-5" data-testid="fix-order">
			<h2 className="text-sm font-semibold">Fix one domain</h2>
			<p className="text-sm text-ink-1" role="status">
				{orderSentence(live, next)}
			</p>
			{live.status === 'pending' && live.action_required && live.action_url ? (
				<Button asChild variant="secondary" size="sm">
					<a href={live.action_url} target="_blank" rel="noopener noreferrer">
						Open your bank's confirmation page
						<ExternalLink aria-hidden />
					</a>
				</Button>
			) : null}
		</section>
	);
}

/** The last finished order, when nothing is open: done, refunded, or a payment that did not go through. */
function OrderNote({ order, next }: { order: Order; next: string }) {
	const failed = order.status === 'failed';
	return failed ? (
		<Alert variant="danger" title="The last payment did not go through">
			{orderSentence(order, next)}
		</Alert>
	) : (
		<p className="rounded-lg border border-line bg-surface-1 px-4 py-3 text-sm text-ink-1 sm:px-5" data-testid="fix-order-note">
			{orderSentence(order, next)}
		</p>
	);
}
