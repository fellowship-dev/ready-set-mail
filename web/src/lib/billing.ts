/**
 * Hosted billing in the dashboard: what the server's /api/billing answers, the words around it, and the hooks that read it.
 * Billing is off unless the server says so (every route is a 404 then): the pages render nothing and ask nothing more.
 */
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useHosted } from './session';
import type { DomainAction } from './actions';
import type { PlanView } from './plan';

export type OrderStatus = 'pending' | 'paid' | 'started' | 'done' | 'refunded' | 'failed' | 'canceled';

export interface Card {
	brand: string;
	last4: string;
	exp_month: number;
	exp_year: number;
}

export interface Offer {
	id: string;
	name: string;
	scope: string;
	/** Minor units of `currency`, from the Stripe price. */
	amount: number;
	currency: string;
	refund_rule: string;
	next_steps: string;
}

export interface Order {
	id: string;
	domain: string;
	domain_id: number | null;
	offer: string;
	amount: number;
	/** What Stripe collected (less than `amount` after a credit balance or coupon); null until paid. */
	amount_paid: number | null;
	currency: string;
	status: OrderStatus;
	amount_refunded: number;
	buyer_email: string | null;
	failure_message: string | null;
	action_required: boolean;
	action_url: string | null;
	/** Stripe says the invoice is paid but it is being checked against the order. */
	payment_review: boolean;
	created_at: number;
	paid_at: number | null;
	started_at: number | null;
	done_at: number | null;
	refunded_at: number | null;
	failed_at: number | null;
}

export interface BillingView {
	enabled: true;
	role: 'owner' | 'admin' | 'member';
	can_manage: boolean;
	/** The owner only: admins and members get `card_on_file` and nothing about the card or the email. */
	billing_email?: string | null;
	has_customer: boolean;
	card_on_file: boolean;
	/** The owner only. */
	card?: Card | null;
	card_unavailable?: boolean;
	offer: Offer | null;
	offer_problem: string | null;
	orders: Order[];
	terms_url: string | null;
	refund_policy_url: string | null;
	/** Hosted plan (HOSTED_PLAN on, or a subscription that exists): absent otherwise. */
	plan?: PlanView;
}

export interface DomainBilling {
	domain: { id: number; name: string };
	role: BillingView['role'];
	can_buy: boolean;
	has_customer: boolean;
	card_on_file: boolean;
	/** The owner only. */
	card?: Card | null;
	card_unavailable?: boolean;
	/** The owner only. */
	billing_email?: string | null;
	offer: Offer | null;
	offer_problem: string | null;
	open_order: Order | null;
	orders: Order[];
	terms_url: string | null;
	refund_policy_url: string | null;
}

export const billingKeys = {
	all: ['billing'] as const,
	domain: (id: number) => ['billing', 'domain', id] as const,
	order: (id: string) => ['billing', 'order', id] as const,
};

/** Settings -> Billing. `null`: billing is off here (404), nothing is shown. Only asked on the hosted service. */
export function useBilling(wanted = true) {
	const hosted = useHosted();
	return useQuery({
		queryKey: billingKeys.all,
		enabled: hosted && wanted,
		retry: false,
		staleTime: 15_000,
		// A first payment waiting for the bank: asked again every few seconds until Stripe says paid (the server asks Stripe too).
		refetchInterval: (q) => (q.state.data?.plan?.pending ? 3000 : false),
		queryFn: async (): Promise<BillingView | null> => {
			try {
				return await api<BillingView>('/api/billing');
			} catch (e) {
				if (e instanceof ApiError && e.status === 404) return null;
				throw e;
			}
		},
	});
}

/** One domain's offer, card and orders; only asked once billing is known to be on. */
export function useDomainBilling(domainId: number, enabled: boolean) {
	return useQuery({
		queryKey: billingKeys.domain(domainId),
		enabled,
		retry: false,
		staleTime: 0,
		queryFn: () => api<DomainBilling>(`/api/billing/domains/${domainId}`),
	});
}

/** An order, polled while it is still pending (waiting for Stripe's webhook or for the bank). */
export function useOrder(id: string | null) {
	return useQuery({
		queryKey: billingKeys.order(id ?? ''),
		enabled: !!id,
		retry: false,
		queryFn: async () => (await api<{ order: Order }>(`/api/billing/orders/${id}`)).order,
		refetchInterval: (q) => (q.state.data && q.state.data.status !== 'pending' ? false : 2500),
	});
}

/** Whole amounts without cents, always with the currency code: "$149 USD", "$149.50 USD". Used wherever a charge is stated; the currency comes from the Stripe price. */
export function formatMoney(amount: number, currency: string): string {
	const whole = amount % 100 === 0;
	const code = currency.toUpperCase();
	return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount / 100)} ${code}`;
}

const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', cartes_bancaires: 'Cartes Bancaires' };
export const brandName = (brand: string): string => BRANDS[brand] ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card');

/** "Visa ending 4242, expires 12/28". */
export function cardLine(c: Card): string {
	const mm = String(c.exp_month).padStart(2, '0');
	const yy = String(c.exp_year % 100).padStart(2, '0');
	return `${brandName(c.brand)} ending ${c.last4}, expires ${mm}/${yy}`;
}

/** "Mar 4, 2027" (UTC, so the same date in every browser). */
export const orderDate = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export const STATUS_WORDS: Record<OrderStatus, string> = {
	pending: 'Waiting for payment',
	paid: 'Paid',
	started: 'Started',
	done: 'Done',
	refunded: 'Refunded',
	failed: 'Not paid',
	canceled: 'Canceled',
};

/** The date that belongs to the order's current status. */
export function statusDate(o: Order): number {
	return (o.status === 'paid' ? o.paid_at : o.status === 'started' ? o.started_at : o.status === 'done' ? o.done_at : o.status === 'refunded' ? o.refunded_at : o.status === 'failed' || o.status === 'canceled' ? o.failed_at : null) ?? o.created_at;
}

/** Open = holds the domain's slot: no second order can be placed. */
export const isOpenOrder = (o: Pick<Order, 'status'>): boolean => o.status === 'pending' || o.status === 'paid' || o.status === 'started';

/**
 * Is there something to fix on this domain? The one source is the page's own "Do this next" list: nothing is offered
 * on "Nothing to do", while it is still reading, or when all that is left are notes and lookups that did not finish.
 */
export function hasSomethingToFix(actions: readonly Pick<DomainAction, 'key' | 'status'>[], pending: boolean): boolean {
	if (pending || actions.length === 0 || actions[0]!.key === 'done') return false;
	// A name that does not resolve has nothing to fix yet: the step is to check the spelling.
	if (actions.some((a) => a.key === 'nxdomain')) return false;
	return actions.some((a) => a.status === 'attention' || a.status === 'improve' || a.status === 'approval' || a.status === 'prepared' || a.status === 'gathering');
}

const NOT_CHARGED = 'You have not been charged.';

/**
 * Why a payment did not go through, in plain words, saying once that nothing was taken. The server's own messages already say it (or, for a
 * payment that arrived after the order was closed, say that the buyer WAS charged); Stripe's decline wording does not, so it is added there.
 */
export function failureSentence(o: Pick<Order, 'failure_message'>, fallback?: string | null): string {
	const message = (o.failure_message ?? fallback ?? 'The payment did not go through.').trim();
	return /charged/i.test(message) ? message : `${message} ${NOT_CHARGED}`;
}

/** The sentence on the domain page for an order. Never a promise of when. */
export function orderSentence(o: Order, next: string): string {
	switch (o.status) {
		case 'pending':
			if (o.payment_review) return 'Your payment went through. We are checking it against your order and will write to you.';
			return o.action_required ? "Waiting for your bank's confirmation." : 'Waiting for the payment to be confirmed.';
		case 'paid':
			return `Fix ordered on ${orderDate(o.paid_at ?? o.created_at)}. ${next}`;
		case 'started':
			return `Work started on ${orderDate(o.started_at ?? o.created_at)}. It ends with our written note that the domain is done.`;
		case 'done':
			return `Done on ${orderDate(o.done_at ?? o.created_at)}: we sent our written note that the domain is done.`;
		case 'refunded':
			return `The fee for this fix was refunded on ${orderDate(o.refunded_at ?? o.created_at)}.`;
		case 'failed':
			return `The payment on ${orderDate(o.failed_at ?? o.created_at)} did not go through${o.failure_message ? `: ${failureSentence(o)}` : `. ${NOT_CHARGED}`}`;
		case 'canceled':
			return `The payment on ${orderDate(o.failed_at ?? o.created_at)} was not confirmed. You have not been charged.`;
	}
}

/** Stripe's hosted page for adding a card. Never throws a message that names a Stripe id. */
export async function startCardSession(returnPath: string): Promise<void> {
	const { url } = await api<{ url: string }>('/api/billing/card-session', { method: 'POST', body: { return_path: returnPath } });
	window.location.assign(url);
}

export async function openPortal(): Promise<void> {
	const { url } = await api<{ url: string }>('/api/billing/portal-session', { method: 'POST', body: {} });
	window.location.assign(url);
}
