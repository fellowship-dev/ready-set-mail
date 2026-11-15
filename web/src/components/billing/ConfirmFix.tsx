import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { billingKeys, cardLine, failureSentence, formatMoney, startCardSession, useOrder, type DomainBilling, type Offer, type Order } from '../../lib/billing';
import type { Domain } from '../../lib/types';

interface Purchase {
	order: Order;
	outcome: 'processing' | 'requires_action' | 'failed';
	action_url?: string;
	message?: string;
}

/**
 * The confirm step. It says what is bought, for which domain (shown, never typed), the price from Stripe, the refund rule, what happens next, the
 * links to the terms and refund policy, and which card will be charged. Without a card the one primary action is "Add a card to continue" (Stripe's
 * page, then back to this same step); with one it is "Pay <price>". Only the workspace owner can act; everyone else is told so.
 */
export function ConfirmFix({ open, onOpenChange, domain, billing, offer: shown }: { open: boolean; onOpenChange: (o: boolean) => void; domain: Domain; billing: DomainBilling; offer: Offer }) {
	const qc = useQueryClient();
	// The price Stripe now has, when the server refused the one that was shown (409 price_changed): the step re-renders with it.
	const [repriced, setRepriced] = useState<Pick<Offer, 'amount' | 'currency'> | null>(null);
	const offer: Offer = repriced ? { ...shown, ...repriced } : shown;
	const [purchase, setPurchase] = useState<Purchase | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const sending = useRef(false);
	const price = formatMoney(offer.amount, offer.currency);
	const returnPath = `/domains/${domain.id}?order=fix-one-domain`;
	const polled = useOrder(purchase && purchase.order.status === 'pending' ? purchase.order.id : null);
	const order = polled.data ?? purchase?.order ?? null;

	// Everything starts again each time the step is opened.
	useEffect(() => {
		if (open) {
			setPurchase(null);
			setProblem(null);
			setRepriced(null);
		}
	}, [open]);
	useEffect(() => {
		if (order && order.status !== 'pending') void qc.invalidateQueries({ queryKey: billingKeys.all });
	}, [order?.status]); // eslint-disable-line react-hooks/exhaustive-deps

	const pay = useMutation({
		mutationFn: () => api<Purchase>('/api/billing/orders', { method: 'POST', body: { domain_id: domain.id, offer: offer.id, expected_amount: offer.amount, expected_currency: offer.currency } }),
		onSuccess: (p) => {
			setPurchase(p);
			// The bank's own page opens in a new tab; the order is polled here meanwhile.
			if (p.outcome === 'requires_action' && p.action_url) window.open(p.action_url, '_blank', 'noopener,noreferrer');
			void qc.invalidateQueries({ queryKey: billingKeys.all });
		},
		onError: (e) => {
			const body = (e instanceof ApiError ? e.body : undefined) as { code?: string; order?: Order; amount?: number; currency?: string } | undefined;
			if (body?.code === 'order_open' && body.order) {
				setPurchase({ order: body.order, outcome: 'processing' });
			} else if (body?.code === 'price_changed' && typeof body.amount === 'number' && typeof body.currency === 'string') {
				setRepriced({ amount: body.amount, currency: body.currency });
				setProblem(`The price changed to ${formatMoney(body.amount, body.currency)}. Check it below and confirm again.`);
				void qc.invalidateQueries({ queryKey: billingKeys.all });
			} else {
				setProblem(errorMessage(e));
				void qc.invalidateQueries({ queryKey: billingKeys.all });
			}
		},
		onSettled: () => {
			sending.current = false;
		},
	});
	const addCard = useMutation({ mutationFn: () => startCardSession(returnPath), onError: (e) => setProblem(errorMessage(e)) });

	function confirm() {
		// A second click while the first is in flight sends nothing (the server also guarantees one charge).
		if (sending.current) return;
		sending.current = true;
		setProblem(null);
		pay.mutate();
	}

	const owner = billing.role === 'owner';
	const card = billing.card ?? null;
	const busy = pay.isPending;
	const finished = order && order.status !== 'pending';
	const waitingForBank = order?.status === 'pending' && order.action_required;
	const failedNow = purchase?.outcome === 'failed' || order?.status === 'failed' || order?.status === 'canceled';

	return (
		<Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{offer.name}</DialogTitle>
					<DialogDescription>{offer.scope}</DialogDescription>
				</DialogHeader>

				{order && !failedNow ? (
					<div className="space-y-3" aria-live="polite">
						{finished ? (
							<Alert variant="success" title={order.status === 'paid' ? 'Paid' : 'Your order is in'}>
								{offer.next_steps}
							</Alert>
						) : waitingForBank ? (
							<Alert variant="info" title="Waiting for your bank's confirmation">
								Your bank needs you to confirm this payment. We opened its page in a new tab; this updates by itself once you have.
							</Alert>
						) : (
							<Alert variant="info" title="Confirming your payment">
								This takes a moment and updates by itself.
							</Alert>
						)}
						{waitingForBank && order.action_url ? (
							<Button asChild variant="secondary" size="sm">
								<a href={order.action_url} target="_blank" rel="noopener noreferrer">
									Open the confirmation page again
									<ExternalLink aria-hidden />
								</a>
							</Button>
						) : null}
					</div>
				) : (
					<div className="space-y-4">
						<dl className="divide-y divide-line text-sm">
							<Row label="Domain">
								<span className="font-mono [overflow-wrap:anywhere]">{domain.domain}</span>
							</Row>
							<Row label="Price">
								<strong className="font-semibold">{price}</strong>, once, charged now
							</Row>
							<Row label="Card">{card ? cardLine(card) : billing.card_on_file ? 'A card is on file.' : billing.card_unavailable ? 'We could not read your card just now.' : 'No card on file yet.'}</Row>
							{owner ? <Row label="Billing email">{billing.billing_email ?? 'Your email address'}</Row> : null}
						</dl>
						<p className="text-sm text-ink-1">{offer.refund_rule}</p>
						<p className="text-sm text-ink-1">{offer.next_steps}</p>
						<p className="text-sm text-ink-2">
							{billing.terms_url ? (
								<a className="text-brand-ink underline underline-offset-4" href={billing.terms_url} target="_blank" rel="noreferrer">
									Terms
								</a>
							) : null}
							{billing.terms_url && billing.refund_policy_url ? ' · ' : null}
							{billing.refund_policy_url ? (
								<a className="text-brand-ink underline underline-offset-4" href={billing.refund_policy_url} target="_blank" rel="noreferrer">
									Refund policy
								</a>
							) : null}
						</p>
						{!owner ? <Alert variant="info">Only the workspace owner can add a card or buy.</Alert> : null}
					</div>
				)}

				{failedNow ? (
					<Alert variant="danger" title="The payment did not go through">
						{failureSentence(order ?? { failure_message: null }, purchase?.message)} You can change the card and try again.
					</Alert>
				) : null}
				{problem ? (
					<Alert variant="danger" title="That did not work">
						{problem}
					</Alert>
				) : null}

				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy || addCard.isPending}>
						{finished || waitingForBank ? 'Close' : 'Cancel'}
					</Button>
					{owner && !order ? (
						card ? (
							<Button loading={busy} disabled={busy} onClick={confirm}>
								Pay {price}
							</Button>
						) : (
							<Button loading={addCard.isPending} onClick={() => addCard.mutate()}>
								Add a card to continue
							</Button>
						)
					) : null}
					{owner && failedNow ? (
						<Button loading={addCard.isPending} onClick={() => addCard.mutate()}>
							Change card
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-0.5 py-2 sm:grid-cols-[8rem_1fr] sm:gap-4">
			<dt className="text-ink-2">{label}</dt>
			<dd className="min-w-0 text-ink-1">{children}</dd>
		</div>
	);
}
