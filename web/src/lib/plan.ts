/**
 * The hosted plan in the dashboard (docs/billing.md, "Pay as you go"): what GET /api/billing says about it, the preview a confirm step shows, and every
 * sentence a person reads about money. The server decides everything; a number on screen is Stripe's (through the preview) or the unit price itself.
 * Nothing here computes an amount.
 */
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useBilling, type BillingView } from './billing';

export interface Money {
	amount: number;
	currency: string;
	interval: 'month' | 'year';
}

export interface PlanDomain {
	id: number;
	name: string;
	billable: boolean;
	paused: boolean;
}

export interface PlanView {
	mode: 'off' | 'free_one_domain';
	name: 'free' | 'payg';
	exempt: boolean;
	includes_free_domain: boolean;
	paid_available: boolean;
	help_url: string | null;
	units: number;
	billable: number;
	paused_units: number;
	grandfathered: boolean;
	domains: PlanDomain[];
	status: string | null;
	payment_problem: boolean;
	lapsed: boolean;
	pending: { domains: string[]; action_url: string | null } | null;
	paused_domains: number;
	resume_by_starting: boolean;
	cancel_at_period_end: boolean;
	period_end: number | null;
	interval: 'month' | 'year' | null;
	notice: string | null;
	can_manage: boolean;
	/** Owners only. */
	price?: Money | null;
	quantity?: number | null;
	monthly_amount?: number | null;
	next_invoice?: { amount_due: number; currency: string; date: number | null } | null;
	action_required_url?: string | null;
	/** The plan ended because the card was declined: the card on file is the one that failed. */
	card_declined?: boolean;
	/** Everyone else. */
	ask_owner?: boolean;
}

export interface PaidPreview {
	needs_confirm: boolean;
	domains: string[];
	new_units: number;
	unit_price: Money | null;
	/** Cents charged now (Stripe's preview); null when Stripe could not say. */
	charge_now: number | null;
	next_invoice: { amount_due: number; currency: string; date: number | null } | null;
	then: { amount: number; currency: string; date: number | null } | null;
	plan_starts: boolean;
	no_charge: boolean;
	preview_failed: boolean;
	can_confirm: boolean;
	grandfather: { units: number; billable_now: number; billable_after: number } | null;
	reason: 'free' | 'paid' | 'start' | 'active' | 'payment_pending' | 'payment_problem' | 'no_paid_path';
	proof: { state: 'none' | 'verified' | 'unverified'; domain: string | null; claim_id: number | null; txt_name: string | null; txt_value: string | null; reason: string | null };
}

export interface PaidAddResult {
	added: { domain: string; domain_id: number }[];
	pending: { domain: string; claim_id: number | null; reason?: string }[];
	resumed: string[];
	failed: { domain: string; error: string; code: string | null }[];
	payment: { state: 'requires_action'; action_url: string | null } | null;
}

export const planKeys = {
	preview: (domains: string[], start = false) => ['billing', 'preview', start ? 'start' : domains.join(',')] as const,
};

/** The plan, when the server says there is one (hosted, billing on, HOSTED_PLAN on or a subscription that exists). Null otherwise: nothing about plans is shown. */
export function usePlan(wanted = true): PlanView | null {
	const q = useBilling(wanted);
	return (q.data as (BillingView & { plan?: PlanView }) | null | undefined)?.plan ?? null;
}

/** The plan is enforced here: "free for one domain" applies to this workspace. */
export const planEnforced = (p: PlanView | null): p is PlanView => !!p && p.mode === 'free_one_domain' && !p.exempt;

/** Stripe's numbers for a confirm: the next invoice, or the first one. Only asked for the owner, who is the only one who can confirm. */
export function usePaidPreview(domains: string[], opts: { enabled?: boolean; start?: boolean } = {}) {
	const query = (opts.start ? ['start=1'] : domains.map((d) => `domain=${encodeURIComponent(d)}`)).join('&');
	return useQuery({
		queryKey: planKeys.preview(domains, opts.start),
		enabled: (opts.enabled ?? true) && (opts.start || domains.length > 0),
		retry: false,
		staleTime: 0,
		gcTime: 0,
		queryFn: () => api<PaidPreview>(`/api/billing/domains/preview?${query}`),
	});
}

/** The plan_required answer of an add (HTTP 402), or null for any other error. */
export function planRequiredOf(err: unknown): { message: string; paidAvailable: boolean; helpUrl: string | null; domain: string | null; grandfather: PaidPreview['grandfather']; state: 'none' | 'active' | 'pending' | 'payment_problem' | 'lapsed' } | null {
	if (!(err instanceof ApiError) || err.status !== 402) return null;
	const b = err.body as { code?: string; paid_available?: boolean; help_url?: string | null; domain?: string; grandfather?: PaidPreview['grandfather']; state?: 'none' | 'active' | 'pending' | 'payment_problem' | 'lapsed' } | undefined;
	if (b?.code !== 'plan_required') return null;
	return { message: err.message, paidAvailable: b.paid_available === true, helpUrl: typeof b.help_url === 'string' ? b.help_url : null, domain: b.domain ?? null, grandfather: b.grandfather ?? null, state: b.state ?? 'none' };
}

export function errorCode(err: unknown): string | null {
	return err instanceof ApiError ? ((err.body as { code?: string } | undefined)?.code ?? null) : null;
}

/** "$5" for whole amounts, "$5.50" otherwise. */
export function usd(amount: number, currency = 'usd'): string {
	const whole = amount % 100 === 0;
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount / 100);
}
/** "$12.50": an invoice's amount, always with cents. */
export const invoiceMoney = (amount: number, currency = 'usd'): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
export const perInterval = (m: Money): string => `${usd(m.amount, m.currency)} a ${m.interval}`;

/** "Dec 16" (UTC, so the same day in every browser). */
export const shortDate = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Dec 16, 2026". */
export const longDate = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export const cardMask = (c: { brand: string; last4: string } | null | undefined): string => (c ? `${c.brand ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1) : 'Card'} ···${c.last4}` : 'your card');

/** The sentences, in one place (docs/billing.md; the words are checked by web/test/plan-words.test.ts). */
export const WORDS = {
	askOwner: 'Ask the workspace owner to add more domains.',
	declined: 'Your card was declined. Use another card.',
	bank: 'Your bank needs you to confirm the payment.',
	waitingBank: "Waiting for your bank's confirmation",
	paymentProblem: 'Your last payment did not go through. Update your card to add more domains.',
	couldNotUpdate: 'We could not update your plan; the domain was not added. Try again.',
	noPreview: 'We could not read the price just now. Try again in a minute.',
	notCompleted: 'The payment was not completed, so the domain was not added. You have not been charged.',
	freeIncludes: 'Free: one domain with all its subdomains.',
	noChargeUntil: 'No charge until you add a domain beyond your free one.',
	declinedCard: 'This card was declined.',
	renewalWaiting: 'The renewal is waiting for you.',
};

/** The sentence above the one button of the paid-domain confirm. Every amount is Stripe's: the preview's, or the unit price itself. */
export function confirmSentence(p: PaidPreview, card: string, count = 1): string[] {
	const unit = p.unit_price;
	if (!unit) return [WORDS.noPreview];
	const monthly = perInterval(unit);
	const each = count > 1 ? `${monthly} for each of these ${count} domains` : `${monthly} for this domain`;
	const tail = 'Subdomains included. Cancel any time.';
	if (p.no_charge) return [`${WORDS.noChargeUntil}`, 'Subdomains included. Cancel any time.'];
	if (p.plan_starts) {
		if (p.charge_now === null || p.preview_failed) return [WORDS.noPreview];
		const now = usd(p.charge_now, unit.currency);
		const then = p.then ? `${usd(p.then.amount, p.then.currency)} a ${unit.interval}${p.then.date ? ` from ${shortDate(p.then.date)}` : ''}` : monthly;
		return [`${now} now, then ${then}. Card ${card}.`, tail];
	}
	if (p.preview_failed || !p.next_invoice) return [`${each}, billed with your next invoice.`, tail];
	const inv = p.next_invoice;
	return [`${each}, from today.`, `Your next invoice${inv.date ? ` on ${shortDate(inv.date)}` : ''} to ${card}: ${invoiceMoney(inv.amount_due, inv.currency)} (this month's part plus the next).`, tail];
}

/** The label of the one button: it names what happens at the click, so a charge now says so ("Pay $5 and add") and a prorated add says the monthly price. */
export function confirmLabel(p: PaidPreview, count = 1): string {
	if (p.no_charge && count === 0) return 'Start pay as you go';
	const unit = p.unit_price;
	if (!unit) return 'Add';
	if (p.plan_starts && p.charge_now !== null && p.charge_now > 0) return `Pay ${usd(p.charge_now, unit.currency)} and add`;
	if (count > 1) return `Add ${count} domains`;
	return `Add for ${usd(unit.amount, unit.currency)} a ${unit.interval}`;
}

/** What the zone list's Add button says once something is ticked: the count and the monthly total ("Add 2: $10 a month"). The total is the unit price times the count. */
export function addSelectedLabel(count: number, unit: Money | null | undefined): string {
	if (count === 0) return 'Add';
	return unit ? `Add ${count}: ${usd(unit.amount * count, unit.currency)} a ${unit.interval}` : `Add ${count}`;
}

/** The flash after an add, in what was true: charged at once, or prorated onto the next invoice. */
export function addedText(count: number, unit: Money | null | undefined, chargedNow: number | null): string {
	const noun = count > 1 ? `Added ${count} domains.` : 'Added.';
	if (!unit) return noun;
	if (chargedNow !== null && chargedNow > 0) return `${noun} ${usd(chargedNow, unit.currency)} paid now, then ${usd(unit.amount * count, unit.currency)} a ${unit.interval}.`;
	return `${noun} ${usd(unit.amount, unit.currency)} a ${unit.interval}${count > 1 ? ' each' : ''} from today.`;
}
