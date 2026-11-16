import { Alert, Button, Checkbox, Label, RecordBlock, Skeleton } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { billingKeys, openPortal, startCardSession, useBilling } from '../../lib/billing';
import { cardMask, confirmLabel, confirmSentence, errorCode, perInterval, usd, usePaidPreview, usePlan, WORDS, type PaidAddResult, type PaidPreview, type PlanView } from '../../lib/plan';
import { PlanAlert } from './PlanAlerts';
import { keys } from '../../lib/queries';

/**
 * The paid-domain confirm (and, for a domain whose TXT record is not there yet, the step before it). One screen, one decision: what it costs, when it is
 * charged and to which card (Stripe's own numbers from the invoice preview, never computed here), then ONE button. No card: "Add a card to continue"
 * (Stripe's page, then back to this same step). A bank that wants to confirm the first payment leaves the domain pending, visibly, until it has.
 * `domains`: one name, or several (the Cloudflare zones: one confirm for the total). Only the workspace owner can confirm; everyone else is told whom to ask.
 */
export function PaidAdd({ domains, returnPath, onAdded, onCancel, onFree, cancelLabel = 'Cancel' }: { domains: string[]; returnPath: string; onAdded: (r: PaidAddResult, chargedNow: number | null) => void; onCancel?: () => void; /** The names turn out to fit the free domain: nothing to confirm (the caller adds them the plain way). */ onFree?: () => void; cancelLabel?: string }) {
	const qc = useQueryClient();
	const billing = useBilling();
	const plan = usePlan();
	const b = billing.data ?? null;
	const owner = b?.role === 'owner';
	const preview = usePaidPreview(domains, { enabled: owner });
	const [problem, setProblem] = useState<string | null>(null);
	const [declined, setDeclined] = useState(false);
	const [waiting, setWaiting] = useState<{ action_url: string | null; added: string[] } | null>(null);
	const sending = useRef(false);
	const opened = useRef(false);
	const p = preview.data ?? null;
	const single = domains.length === 1 ? domains[0]! : null;

	const add = useMutation({
		mutationFn: () => {
			if (!p || !p.unit_price) throw new Error('no price');
			const body = { expected_amount: p.unit_price.amount, expected_currency: p.unit_price.currency, ...(p.plan_starts && p.charge_now !== null ? { expected_charge: p.charge_now } : {}) };
			return api<PaidAddResult>(single ? '/api/billing/domains' : '/api/billing/domains/bulk', { method: 'POST', body: single ? { domain: single, ...body } : { domains, ...body } });
		},
		onSuccess: (r) => {
			void qc.invalidateQueries({ queryKey: billingKeys.all });
			void qc.invalidateQueries({ queryKey: keys.domains });
			if (r.payment) {
				setWaiting({ action_url: r.payment.action_url, added: r.added.map((a) => a.domain) });
				if (r.payment.action_url && !opened.current) { opened.current = true; window.open(r.payment.action_url, '_blank', 'noopener,noreferrer'); }
				return;
			}
			if (r.added.length > 0) { onAdded(r, p && p.plan_starts ? p.charge_now : null); return; }
			// Nothing was added and nothing was charged: the proof is not there yet, or the server said why.
			const why = r.failed[0]?.error ?? null;
			if (why) setProblem(why);
			void preview.refetch();
		},
		onError: (e) => {
			const code = errorCode(e);
			const body = (e instanceof ApiError ? e.body : undefined) as { charge_now?: number; amount?: number } | undefined;
			if (code === 'price_changed') { setProblem('The price changed. Check it below and confirm again.'); void preview.refetch(); }
			else if (code === 'payment_failed') setDeclined(true);
			else if (code === 'payment_problem') setProblem(WORDS.paymentProblem);
			else if (code === 'plan_update_failed') setProblem(WORDS.couldNotUpdate);
			else if (code === 'plan_busy') setProblem('Another change is being made. Try again in a moment.');
			else if (code === 'card_required') void qc.invalidateQueries({ queryKey: billingKeys.all });
			else setProblem(errorMessage(e));
			void body;
			void qc.invalidateQueries({ queryKey: billingKeys.all });
		},
		onSettled: () => { sending.current = false; },
	});
	const card = useMutation({ mutationFn: () => startCardSession(returnPath), onError: (e) => setProblem(errorMessage(e)) });
	const portal = useMutation({ mutationFn: openPortal, onError: (e) => setProblem(errorMessage(e)) });

	// The confirm waits for the bank: it is done when the server says the plan has started (the page polls the plan).
	useEffect(() => {
		// Done when the plan has STARTED (Stripe says paid), not merely when no payment is pending: the cached plan is the one from before the click.
		if (waiting && plan && plan.name === 'payg' && !plan.pending) onAdded({ added: waiting.added.map((domain) => ({ domain, domain_id: 0 })), pending: [], resumed: [], failed: [], payment: null }, p && p.plan_starts ? p.charge_now : null);
	}, [waiting, plan?.pending]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => { if (p && !p.needs_confirm && p.reason === 'free') onFree?.(); }, [p?.reason]); // eslint-disable-line react-hooks/exhaustive-deps
	if (!b) return <Skeleton className="h-40 w-full" />;
	if (!owner) return <Alert variant="info">{WORDS.askOwner}</Alert>;
	if (waiting) {
		// ONE alert for the wait, here (the banner and Settings stay quiet on this page): what is happening, "Try again" for the bank's page, "Cancel" to give the domain up.
		const waitingPlan: PlanView | null = plan ? { ...plan, can_manage: true, pending: { domains: waiting.added, action_url: waiting.action_url } } : null;
		return <div aria-live="polite">{waitingPlan ? <PlanAlert plan={waitingPlan} onCancelled={() => { setWaiting(null); onCancel?.(); }} /> : <Alert variant="info" title={WORDS.waitingBank}>Your bank needs you to confirm this payment. This updates by itself once you have.</Alert>}</div>;
	}
	if (preview.isPending) return <div aria-busy="true" role="status"><Skeleton className="h-40 w-full" /><span className="sr-only">Reading the price…</span></div>;
	if (preview.isError || !p) return <Alert variant="danger" title="That did not work">{preview.error ? errorMessage(preview.error) : WORDS.noPreview}<Button variant="secondary" size="sm" className="mt-3" onClick={() => void preview.refetch()}>Try again</Button></Alert>;

	// Adding is paused (a payment problem) or waiting (the bank): say so first, before asking for any DNS record that could not be used yet.
	if (!p.needs_confirm && p.reason === 'payment_problem') {
		return (
			<div className="space-y-3">
				<Alert variant="warning" title="Adding more domains is paused">{WORDS.paymentProblem}</Alert>
				<div className="flex flex-wrap gap-2"><Button loading={portal.isPending} onClick={() => portal.mutate()}>Update your card</Button>{onCancel ? <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button> : null}</div>
			</div>
		);
	}
	if (!p.needs_confirm && p.reason === 'payment_pending') return plan?.pending ? <PlanAlert plan={plan} /> : <Alert variant="info" title={WORDS.waitingBank}>Your bank needs you to confirm the first payment. This updates by itself once you have.</Alert>;
	// A domain that is not proven yet: the record first (one decision: check it), the money after.
	if (p.proof.state === 'unverified' && p.proof.txt_name && p.proof.txt_value) {
		return (
			<div className="space-y-4">
				<p className="text-sm text-ink-2">Add this TXT record where you manage {p.proof.domain}, then check it. Nothing is charged until the domain is verified and you confirm.</p>
				<RecordBlock title="Verification record" record={{ type: 'TXT', name: p.proof.txt_name, value: p.proof.txt_value, ttl: '3600 (or your provider default)' }} />
				{p.proof.reason && preview.isFetched && !preview.isFetching && preview.dataUpdatedAt > 0 ? <p className="text-sm text-ink-2">Not found yet. DNS changes can take a few minutes.</p> : null}
				<div className="flex flex-wrap gap-2">
					<Button loading={preview.isFetching} onClick={() => void preview.refetch()}>Check the record</Button>
					{onCancel ? <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button> : null}
				</div>
			</div>
		);
	}

	if (!p.needs_confirm && p.reason === 'free' && onFree) return <Skeleton className="h-10 w-full" />;
	if (!p.needs_confirm) return <Alert variant="info">{p.reason === 'no_paid_path' ? 'More domains: talk to us.' : 'Nothing to confirm here.'}</Alert>;

	const hasCard = !!b.card_on_file;
	const cardName = cardMask(b.card);
	// No card yet: the plain unit price and what happens next; the exact amount comes with the card, before anything is charged.
	const lines = hasCard ? confirmSentence(p, cardName, domains.length)
		: p.unit_price ? [p.grandfather ? `Pay as you go bills ${p.grandfather.billable_after} ${p.grandfather.billable_after === 1 ? 'domain' : 'domains'} at ${perInterval(p.unit_price)} each. Subdomains included. Cancel any time.` : `${perInterval(p.unit_price)} ${domains.length > 1 ? `for each of these ${domains.length} domains` : 'for this domain'}. Subdomains included. Cancel any time.`, 'Add a card first: you see the exact amount before you pay.']
		: [WORDS.noPreview];
	const grandfather = p.grandfather && p.grandfather.units > 1 ? p.grandfather : null;

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,22rem)] lg:items-start">
		<div className="space-y-4">
			{grandfather ? (
				<p className="text-sm text-ink-1">
					This workspace already holds {grandfather.units} domains, and only one is free. Pay as you go bills the other {grandfather.units - 1} too; the domains you hold keep working either way.
				</p>
			) : null}
			<div className="space-y-1.5" aria-live="polite">
				{lines.map((l, i) => (
					<p key={i} className={i === 0 ? 'text-base font-medium text-ink-1' : 'text-sm text-ink-2'}>{l}</p>
				))}
			</div>
			{domains.length > 1 ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{domains.join(', ')}</p> : null}
			{b.terms_url ? <p className="text-sm text-ink-2"><a className="text-brand-ink underline underline-offset-4" href={b.terms_url} target="_blank" rel="noreferrer">Terms</a></p> : null}
			{declined ? (
				<Alert variant="danger" title="The payment did not go through">{WORDS.declined} Nothing was added.</Alert>
			) : null}
			{problem ? <Alert variant="danger" title="That did not work">{problem}</Alert> : null}
			<div className="flex flex-wrap gap-2">
				{!hasCard || declined ? (
					<Button loading={card.isPending} onClick={() => card.mutate()}>{declined ? 'Change card' : 'Add a card to continue'}</Button>
				) : (
					<Button
						loading={add.isPending}
						disabled={add.isPending || !p.can_confirm}
						onClick={() => { if (sending.current) return; sending.current = true; setProblem(null); setDeclined(false); add.mutate(); }}
					>
						{confirmLabel(p, domains.length)}
					</Button>
				)}
				{onCancel ? <Button variant="secondary" onClick={onCancel} disabled={add.isPending}>{cancelLabel}</Button> : null}
			</div>
		</div>
		{plan ? <WorkspaceBill plan={plan} adding={domains} /> : null}
		</div>
	);
}

/**
 * Beside the confirm, on a wide screen only: what the workspace holds and what each domain is, so the person sees the bill this add leads to. Facts from the
 * plan (the unit price is Stripe's; the free domain is the workspace's allowance). Nothing here is asked or decided.
 */
function WorkspaceBill({ plan, adding }: { plan: PlanView; adding: string[] }) {
	const unit = plan.price ?? null;
	const price = unit ? `${usd(unit.amount, unit.currency)} a ${unit.interval}` : 'Billed monthly';
	const held = plan.domains.filter((d) => !adding.includes(d.name));
	return (
		<aside aria-label="This workspace" className="hidden space-y-3 rounded-lg border border-line p-4 lg:block">
			<h2 className="text-sm font-semibold tracking-tight">In this workspace</h2>
			<ul className="divide-y divide-line text-sm">
				{held.map((d) => (
					<li key={d.id} className="flex items-baseline justify-between gap-3 py-2"><span className="font-mono [overflow-wrap:anywhere]">{d.name}</span><span className="shrink-0 text-ink-2">{d.billable ? price : 'Free'}</span></li>
				))}
				{adding.map((name) => (
					<li key={name} className="flex items-baseline justify-between gap-3 py-2"><span className="font-mono [overflow-wrap:anywhere]">{name}</span><span className="shrink-0 text-ink-1">{price}</span></li>
				))}
			</ul>
			<p className="text-sm text-ink-2">Subdomains of a domain are part of it: they never add to the bill.</p>
		</aside>
	);
}

/** One checkbox per zone, for "Also in your Cloudflare account". */
export function ZoneChoice({ name, checked, onChange }: { name: string; checked: boolean; onChange: (v: boolean) => void }) {
	const id = `zone-${name}`;
	return (
		<div className="flex items-center gap-3 py-2">
			<Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
			<Label htmlFor={id} className="font-mono text-sm [overflow-wrap:anywhere]">{name}</Label>
		</div>
	);
}

export type { PaidPreview };
