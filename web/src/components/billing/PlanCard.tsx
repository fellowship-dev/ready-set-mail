import { Alert, Button, Card, CardContent, CardFooter, Skeleton } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { billingKeys, openPortal, startCardSession, type BillingView } from '../../lib/billing';
import { useStripParams } from '../../lib/card-return';
import { cardMask, confirmSentence, errorCode, invoiceMoney, longDate, perInterval, usePaidPreview, usd, WORDS, type PlanView } from '../../lib/plan';
import { KeepOne } from './KeepOne';
import { PlanAlert, planAlertKind } from './PlanAlerts';

/**
 * Does the plan card carry the one way to Stripe's portal (card, invoices, cancel)? Then the card box below it keeps card and billing email as plain facts.
 * A payment problem has its own "Update your card" in the alert, so the portal is not offered twice there either.
 */
export const planCardHasPortal = (plan: PlanView | null | undefined): boolean => !!plan && !plan.exempt && plan.can_manage && plan.name === 'payg' && !plan.lapsed && planAlertKind(plan) !== 'renewal';

/**
 * Settings → Billing, the plan: its name (Free or Pay as you go), one or two sentences about it, and the ONE action its state calls for. No pricing table:
 * the unit price is said in a sentence. Owners act; everyone else reads and is told whom to ask.
 */
export function PlanCard({ plan, billing }: { plan: PlanView; billing: BillingView }) {
	const qc = useQueryClient();
	const [params] = useSearchParams();
	const strip = useStripParams();
	const [starting, setStarting] = useState(() => params.get('plan') === 'start');
	const portal = useMutation({ mutationFn: openPortal });
	const owner = plan.can_manage;
	const unit = plan.price ?? null;
	const money = unit ? perInterval(unit) : null;
	const payg = plan.name === 'payg' && !plan.lapsed;
	const title = payg ? 'Pay as you go' : 'Free';

	if (plan.exempt) return <Card><CardContent className="py-4"><p className="text-sm text-ink-1">No plan applies to this workspace.</p></CardContent></Card>;

	let body: React.ReactNode;
	let action: React.ReactNode = null;
	const alert = planAlertKind(plan);
	if (plan.pending) {
		body = <PlanAlert plan={plan} />;
	} else if (!payg) {
		const heldMore = plan.grandfathered ? `This workspace holds ${plan.units} domains and only one is free.` : null;
		body = (
			<div className="space-y-2">
				{plan.lapsed ? <p className="text-sm text-ink-1">{plan.card_declined ? 'Pay as you go ended because a payment did not go through.' : 'Pay as you go ended.'} {plan.paused_domains > 0 ? `${plan.includes_free_domain ? 'Domains beyond your free one are' : 'Your domains are'} paused: you can read and export them.` : ''}</p> : <p className="text-sm text-ink-1">{plan.includes_free_domain ? WORDS.freeIncludes : 'This workspace has no free domain.'}</p>}
				{heldMore && !starting ? <p className="text-sm text-ink-2">{heldMore}</p> : null}
				{!plan.paid_available ? <p className="text-sm text-ink-2">More domains: talk to us.</p>
					: !owner ? <p className="text-sm text-ink-1">{plan.lapsed ? 'Ask the workspace owner to start pay as you go again to resume them.' : WORDS.askOwner}</p>
					: <p className="text-sm text-ink-2">{plan.lapsed ? (plan.card_declined ? 'Update your card, then start pay as you go again to resume them.' : 'Start pay as you go again to resume them.') : `More domains are pay as you go${money ? `: ${money} for each` : ''}. Cancel any time.`}</p>}
			</div>
		);
		if (owner && plan.paid_available && !starting) action = <Button variant={plan.card_declined ? 'secondary' : 'primary'} onClick={() => setStarting(true)}>{plan.lapsed ? 'Start pay as you go again' : 'Start pay as you go'}</Button>;
	} else {
		const sentence = plan.includes_free_domain ? `Your first domain is free. Each domain beyond it is ${money ?? 'billed monthly'}.` : `Each domain is ${money ?? 'billed monthly'}.`;
		body = (
			<div className="space-y-3">
				<p className="text-sm text-ink-1">{sentence} Subdomains are included.</p>
				{owner ? (
					<dl className="divide-y divide-line text-sm">
						<Line label="Domains billed">
							{plan.billable === 0 ? 'None yet' : `${plan.billable}${money ? ` × ${perInterval(unit!)}` : ''}`}
							{plan.domains.some((d) => d.billable) ? <ul className="mt-1 space-y-0.5 text-ink-2">{plan.domains.filter((d) => d.billable).map((d) => <li key={d.id} className="font-mono [overflow-wrap:anywhere]">{d.name}</li>)}</ul> : null}
						</Line>
						{plan.cancel_at_period_end && plan.period_end ? (
							<Line label="Ends">{longDate(plan.period_end)}. Your domains keep working until then.</Line>
						) : plan.next_invoice && plan.billable > 0 ? (
							<Line label="Next invoice">{plan.next_invoice.date ? `${longDate(plan.next_invoice.date)}: ` : ''}{invoiceMoney(plan.next_invoice.amount_due, plan.next_invoice.currency)}</Line>
						) : plan.billable === 0 ? <Line label="Next invoice">Nothing to pay yet</Line> : null}
					</dl>
				) : <p className="text-sm text-ink-1">{WORDS.askOwner}</p>}
				{alert ? <PlanAlert plan={plan} /> : null}
			</div>
		);
	}

	return (
		<Card>
			<CardContent className="space-y-3 py-4">
				<h3 className="text-base font-semibold tracking-tight">{title}</h3>
				{body}
				{owner && starting && !payg ? <StartPlan plan={plan} billing={billing} onCancel={() => { setStarting(false); strip('plan'); }} onStarted={() => { setStarting(false); strip('plan'); void qc.invalidateQueries({ queryKey: billingKeys.all }); }} /> : null}
				{portal.isError ? <Alert variant="danger" title="That did not work">{errorMessage(portal.error)}</Alert> : null}
			</CardContent>
			{action || (payg && owner && !alert) ? (
				<CardFooter className="flex-wrap justify-between gap-3">
					<div>{action}</div>
					{payg && owner && !alert ? <Button variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}><ExternalLink aria-hidden />Change card, see invoices or cancel</Button> : null}
				</CardFooter>
			) : null}
		</Card>
	);
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-0.5 py-2 sm:grid-cols-[9rem_1fr] sm:gap-4">
			<dt className="text-ink-2">{label}</dt>
			<dd className="min-w-0 text-ink-1">{children}</dd>
		</div>
	);
}

/** "Start pay as you go": no charge for most; a workspace that already holds more than its free domain is charged its first invoice now, by Stripe's own number. */
function StartPlan({ plan, billing, onCancel, onStarted }: { plan: PlanView; billing: BillingView; onCancel: () => void; onStarted: () => void }) {
	const preview = usePaidPreview([], { start: true });
	const [problem, setProblem] = useState<string | null>(null);
	const [keeping, setKeeping] = useState(false);
	const [waiting, setWaiting] = useState<string | null>(null);
	const p = preview.data ?? null;
	const card = useMutation({ mutationFn: () => startCardSession('/settings?plan=start'), onError: (e) => setProblem(errorMessage(e)) });
	const start = useMutation({
		mutationFn: () => api<{ plan: 'payg'; payment: { action_url: string | null } | null }>('/api/billing/plan/start', { method: 'POST', body: { ...(p?.unit_price ? { expected_amount: p.unit_price.amount, expected_currency: p.unit_price.currency } : {}), ...(p?.charge_now ? { expected_charge: p.charge_now } : {}) } }),
		onSuccess: (r) => {
			if (r.payment) { setWaiting(r.payment.action_url ?? ''); if (r.payment.action_url) window.open(r.payment.action_url, '_blank', 'noopener,noreferrer'); return; }
			onStarted();
		},
		onError: (e) => {
			const code = errorCode(e);
			if (code === 'payment_failed') setProblem(WORDS.declined);
			else if (code === 'price_changed') { setProblem('The price changed. Check it below and confirm again.'); void preview.refetch(); }
			else setProblem(errorMessage(e));
		},
	});
	if (waiting !== null) return <Alert variant="info" title={WORDS.waitingBank}>Your bank needs you to confirm this payment. {waiting ? 'We opened its page in a new tab; ' : ''}this updates by itself once you have.</Alert>;
	if (preview.isPending) return <Skeleton className="h-24 w-full" />;
	if (!p) return <Alert variant="danger" title="That did not work">{preview.error ? errorMessage(preview.error) : WORDS.noPreview}</Alert>;
	const hasCard = !!billing.card_on_file;
	const lines = hasCard ? confirmSentence(p, cardMask(billing.card))
		: p.grandfather && p.unit_price ? [`Starting bills ${p.grandfather.billable_now} ${p.grandfather.billable_now === 1 ? 'domain' : 'domains'} at ${perInterval(p.unit_price)} each.`, 'Add a card first: you see the exact amount before you pay.']
		: [WORDS.noChargeUntil, 'Add a card first.'];
	return (
		<div className="space-y-3 border-t border-line pt-3">
			{p.grandfather ? <p className="text-sm text-ink-1">This workspace holds {p.grandfather.units} domains and only one is free.</p> : null}
			{lines.map((l, i) => <p key={i} className={i === 0 ? 'text-sm font-medium text-ink-1' : 'text-sm text-ink-2'}>{l}</p>)}
			{problem ? <Alert variant="danger" title="That did not work">{problem}</Alert> : null}
			<div className="flex flex-wrap gap-2">
				{hasCard ? <Button loading={start.isPending} disabled={!p.can_confirm || start.isPending} onClick={() => { setProblem(null); start.mutate(); }}>Start pay as you go</Button> : <Button loading={card.isPending} onClick={() => card.mutate()}>Add a card to continue</Button>}
				{p.grandfather && plan.includes_free_domain ? <Button variant="secondary" onClick={() => setKeeping(true)}>Keep one free domain instead</Button> : null}
				<Button variant="secondary" onClick={onCancel}>Cancel</Button>
			</div>
			{keeping ? <KeepOne plan={plan} onClose={() => setKeeping(false)} onDone={() => { setKeeping(false); onStarted(); }} /> : null}
		</div>
	);
}

export { usd };
